import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "rolldown";
import { sharedRuntimePlugin } from "../tools/shared-runtime.mjs";

test("identical taraba runtimes share one ESM chunk; different profiles stay separate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taraba-esm-"));
  try {
    const variants = ["jspi", "jspi", "jspi-debug", "future", "jspi"];
    const entries = [],
      runtimes = [];
    for (const [i, variant] of variants.entries()) {
      const pkg = join(dir, `pkg-${i}`);
      mkdirSync(pkg);
      const runtime = join(pkg, "runtime.mjs");
      writeFileSync(
        runtime,
        readFileSync(
          `crates/taraba-cli/assets/${variant === "future" ? "taraba" : `taraba-${variant}`}.mjs`,
        ),
      );
      const entry = join(pkg, "index.mjs");
      writeFileSync(entry, 'export {createHost} from "./runtime.mjs";\n');
      entries.push(entry);
      runtimes.push(runtime);
    }
    const original = await Promise.all(
      entries.map((p) => import(pathToFileURL(p))),
    );
    assert.notEqual(original[0].createHost, original[1].createHost);
    assert.equal(original[0], await import(pathToFileURL(entries[0])));
    const output = await build({
      input: Object.fromEntries(entries.map((p, i) => [`lib-${i}`, p])),
      platform: "neutral",
      transform: { target: "es2022" },
      output: {
        dir: join(dir, "bundled"),
        format: "esm",
        minify: true,
        entryFileNames: "[name].mjs",
        chunkFileNames: "[name]-[hash].mjs",
      },
      plugins: [sharedRuntimePlugin(runtimes.slice(0, 4))],
    });
    const bundled = await Promise.all(
      entries.map(
        (_, i) => import(pathToFileURL(join(dir, "bundled", `lib-${i}.mjs`))),
      ),
    );
    assert.equal(bundled[0].createHost, bundled[1].createHost);
    assert.notEqual(bundled[0].createHost, bundled[2].createHost);
    assert.notEqual(bundled[0].createHost, bundled[3].createHost);
    assert.notEqual(
      bundled[0].createHost,
      bundled[4].createHost,
      "unselected runtimes must not be redirected, even with identical contents",
    );
    const emitted = output.output.filter((o) => o.type === "chunk");
    const inputs = [
      ...new Set(emitted.flatMap((o) => Object.keys(o.modules))),
    ].filter((p) => p.endsWith("/runtime.mjs"));
    assert.equal(inputs.length, 4);
    const chunks = emitted.filter(
      (o) =>
        !o.isEntry &&
        Object.keys(o.modules).some((p) => p.endsWith("/runtime.mjs")),
    );
    assert.equal(chunks.length, 1);
    assert.equal(
      Object.keys(chunks[0].modules).filter((p) => p.endsWith("/runtime.mjs"))
        .length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("application bindings are never deduplicated, even when explicitly selected and byte-identical", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taraba-app-esm-"));
  try {
    const runtimes = [],
      apps = [];
    for (const name of ["a", "b"]) {
      const pkg = join(dir, name);
      mkdirSync(pkg);
      const runtime = join(pkg, "runtime.mjs"),
        app = join(pkg, "index.js");
      writeFileSync(runtime, "export const shared = {};\n");
      writeFileSync(
        app,
        'export {shared} from "./runtime.mjs"; export const local = {};\n',
      );
      runtimes.push(runtime);
      apps.push(app);
    }
    const output = join(dir, "out");
    await build({
      input: { a: apps[0], b: apps[1] },
      output: { dir: output, format: "esm", entryFileNames: "[name].mjs" },
      plugins: [sharedRuntimePlugin([...runtimes, ...apps])],
    });
    const [a, b] = await Promise.all(
      ["a", "b"].map(
        (name) => import(pathToFileURL(join(output, `${name}.mjs`))),
      ),
    );
    assert.equal(a.shared, b.shared);
    assert.notEqual(a.local, b.local);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
