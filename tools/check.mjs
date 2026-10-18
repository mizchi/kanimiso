import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { instantiate } from "../tests/support/adapter.mjs";
import { verifyPromises } from "../tests/support/promises.mjs";
import {
  verifyCompute,
  verifyPoolCapacity,
} from "../tests/support/minimal.mjs";
import { verifyStorage } from "../tests/support/storage.mjs";
import { verifyLocal } from "../tests/support/regressions.mjs";
import { verifyFailures } from "../tests/support/failures.mjs";
import { fuzz } from "../tests/support/fuzz.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entries = [];
let expected;
for (const variant of ["release", "debug"])
  for (const mode of ["no_std", "std"]) {
    const { createHost } = await import(`../dist/${variant}.mjs`),
      full = readFileSync(`dist/examples/${mode}-full.wasm`),
      minimal = readFileSync(`dist/examples/${mode}-minimal.wasm`),
      probes = readFileSync(`dist/examples/${mode}-probes.wasm`);
    const { api } = await instantiate(full, {}, createHost),
      common = await verifyPromises(api);
    if (expected) assert.deepEqual(common.common, expected);
    else expected = common.common;
    const compute = await verifyCompute(minimal, createHost, expected.actual),
      regressions = await verifyLocal(probes, { createHost }),
      failures = await verifyFailures(probes, createHost),
      storage = await verifyStorage(probes, createHost, "pool"),
      capacity = await verifyPoolCapacity(probes, createHost),
      randomized = await fuzz(probes, {
        factory: createHost,
        seed: 42,
        steps: 10000,
        fatalAtEnd: true,
      });
    const entry = {
      variant,
      mode,
      common,
      compute,
      regressions,
      failures,
      storage,
      capacity,
      fuzz: randomized,
      sizes: {
        wasm: minimal.length,
        host: readFileSync(`dist/${variant}.mjs`).length,
        package_loader: readFileSync(
          `dist/${variant === "debug" ? "index-debug" : "index"}.mjs`,
        ).length,
      },
      wasm_sha256: hash(minimal),
      host_sha256: hash(readFileSync(`dist/${variant}.mjs`)),
    };
    entries.push(entry);
    console.log(
      `${variant}/${mode}: ${minimal.length} B Wasm; regressions ${regressions.cases}, fatal cases ${failures.cases.length}; passed`,
    );
  }
mkdirSync(".cache", { recursive: true });
writeFileSync(
  ".cache/check.json",
  JSON.stringify(
    {
      created_at: new Date().toISOString(),
      engine: `Node ${process.version} / V8 ${process.versions.v8}`,
      entries,
      all_passed: true,
    },
    null,
    2,
  ) + "\n",
);
