import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { rolldown } from "rolldown";

// Context for the README's Why section, not an equivalent-workload benchmark.
const dependencies = {
  react: "19.3.1",
  "react-dom": "19.3.1",
  preact: "11.0.1",
  zod: "4.6.7",
  hono: "4.13.13",
  valibot: "1.5.0",
};
const entries = [
  {
    id: "react",
    name: "React (core)",
    version: dependencies.react,
    source: `export {createElement, useState} from 'react';`,
  },
  {
    id: "react-dom",
    name: "React + React DOM",
    version: dependencies.react,
    source: `import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
export function mount(target) {createRoot(target).render(createElement('span', null, 'ok'));}`,
  },
  {
    id: "preact",
    name: "Preact",
    version: dependencies.preact,
    source: `import {h, render} from 'preact';
export function mount(target) {render(h('span', null, 'ok'), target);}`,
  },
  {
    id: "zod",
    name: "Zod",
    version: dependencies.zod,
    source: `import {object, string} from 'zod';
const schema = object({name: string()});
export function parse(value) {return schema.parse(value);}`,
  },
  {
    id: "hono",
    name: "Hono",
    version: dependencies.hono,
    source: `import {Hono} from 'hono';
const app = new Hono();
app.get('/', c => c.text('ok'));
export const fetch = app.fetch;`,
  },
  {
    id: "valibot",
    name: "Valibot",
    version: dependencies.valibot,
    source: `import {object, string, parse as validate} from 'valibot';
const schema = object({name: string()});
export function parse(value) {return validate(schema, value);}`,
  },
];
const dir = resolve(".cache/frontend-size-reference");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies,
    pnpm: { overrides: { scheduler: "0.28.0" } },
  }),
);
execFileSync(
  "pnpm",
  ["--dir", dir, "install", "--ignore-workspace", "--ignore-scripts"],
  { stdio: "pipe" },
);
for (const [name, version] of Object.entries(dependencies))
  assert.equal(
    JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json")))
      .version,
    version,
  );
const options = {
  platform: "browser",
  transform: {
    target: "es2022",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  },
};
const output = { format: "esm", minify: true };
const results = [];
for (const entry of entries) {
  const input = join(dir, `${entry.id}.mjs`);
  writeFileSync(input, entry.source);
  const bundle = await rolldown({ ...options, input });
  let generated;
  try {
    generated = await bundle.generate(output);
  } finally {
    await bundle.close();
  }
  assert.equal(generated.output.length, 1, "count every emitted file");
  const chunk = generated.output[0];
  assert.equal(chunk.type, "chunk");
  assert.equal(chunk.imports.length, 0, "dependencies must be bundled");
  assert.equal(chunk.dynamicImports.length, 0, "no uncounted dynamic imports");
  const bytes = Buffer.from(chunk.code);
  const artifact = join(dir, `${entry.id}.bundle.mjs`);
  writeFileSync(artifact, bytes);
  const api = await import(pathToFileURL(artifact));
  if (entry.id === "react") {
    assert.equal(api.createElement("span", null, "ok").props.children, "ok");
    assert.equal(typeof api.useState, "function");
  } else if (entry.id === "react-dom" || entry.id === "preact") {
    assert.equal(typeof api.mount, "function"); // No DOM/browser execution claim.
  } else if (entry.id === "hono") {
    const response = await api.fetch(new Request("https://example.test/"));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(
      (await api.fetch(new Request("https://example.test/missing"))).status,
      404,
    );
  } else {
    assert.deepEqual(api.parse({ name: "taraba" }), { name: "taraba" });
    for (const invalid of [{ name: 42 }, {}, null])
      assert.throws(() => api.parse(invalid));
  }
  results.push({
    ...entry,
    raw_bytes: bytes.length,
    gzip_bytes: gzipSync(bytes, { level: 9 }).length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const report = {
  created_at: new Date().toISOString(),
  node: process.version,
  rolldown: JSON.parse(readFileSync("node_modules/rolldown/package.json"))
    .version,
  dependencies,
  overrides: { scheduler: "0.28.0" },
  options,
  output,
  gzip_level: 9,
  note: "Representative entry bundles, not complete packages or equivalent workloads. DOM rendering is not executed.",
  entries: results,
};
const reportPath = process.argv.includes("--check")
  ? join(dir, "report.json")
  : resolve("docs/frontend-size.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
for (const r of results)
  console.log(
    `${r.name} ${r.version}: ${r.raw_bytes} B / gzip ${r.gzip_bytes} B`,
  );
