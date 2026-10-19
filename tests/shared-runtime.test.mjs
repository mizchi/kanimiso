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
      const runtime = join(pkg, "taraba.mjs");
      writeFileSync(
        runtime,
        readFileSync(
          `crates/taraba-cli/assets/${variant === "future" ? "taraba" : `taraba-${variant}`}.mjs`,
        ),
      );
      const entry = join(pkg, "index.mjs");
      writeFileSync(entry, 'export {instantiate} from "./taraba.mjs";\n');
      entries.push(entry);
      runtimes.push(runtime);
    }
    const original = await Promise.all(
      entries.map((p) => import(pathToFileURL(p))),
    );
    assert.notEqual(original[0].instantiate, original[1].instantiate);
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
    assert.equal(bundled[0].instantiate, bundled[1].instantiate);
    assert.notEqual(bundled[0].instantiate, bundled[2].instantiate);
    assert.notEqual(bundled[0].instantiate, bundled[3].instantiate);
    assert.notEqual(
      bundled[0].instantiate,
      bundled[4].instantiate,
      "unselected runtimes must not be redirected, even with identical contents",
    );
    const emitted = output.output.filter((o) => o.type === "chunk");
    const inputs = [
      ...new Set(emitted.flatMap((o) => Object.keys(o.modules))),
    ].filter((p) => p.endsWith("/taraba.mjs"));
    assert.equal(inputs.length, 4);
    const chunks = emitted.filter(
      (o) =>
        !o.isEntry &&
        Object.keys(o.modules).some((p) => p.endsWith("/taraba.mjs")),
    );
    assert.equal(chunks.length, 1);
    assert.equal(
      Object.keys(chunks[0].modules).filter((p) => p.endsWith("/taraba.mjs"))
        .length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
