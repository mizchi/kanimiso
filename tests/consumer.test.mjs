import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instantiate } from "../dist/index.mjs";

test("an application can bind its own ABI, including identical import/export names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kanimiso-consumer-"));
  try {
    writeFileSync(
      `${dir}/raw.wat`,
      '(module (import "app" "identity" (func $id (param i32) (result i32))) (memory (export "memory") 4 16) (func (export "identity") (param i32) (result i32) local.get 0 call $id))',
    );
    execFileSync(".cache/toolchains/binaryen-version_133/bin/wasm-as", [
      `${dir}/raw.wat`,
      "-o",
      `${dir}/raw.wasm`,
    ]);
    writeFileSync(
      `${dir}/abi.json`,
      JSON.stringify({
        imports: { "app.identity": { params: ["own"], result: "own" } },
        exports: { identity: { params: ["own"], result: "own" } },
      }),
    );
    execFileSync(process.execPath, [
      "tools/build-wasm.mjs",
      `${dir}/raw.wasm`,
      "--abi",
      `${dir}/abi.json`,
      "--output",
      `${dir}/app.wasm`,
    ]);
    const bytes = readFileSync(`${dir}/app.wasm`),
      module = new WebAssembly.Module(bytes);
    assert.ok(
      WebAssembly.Module.imports(module).some(
        (i) => i.module === "app" && i.name === "identity",
      ),
    );
    for (const source of [bytes, module]) {
      const host = await instantiate(source, {
          bindings: { identity: (v) => v },
        }),
        value = { hello: "world" };
      assert.equal(host.call("identity", value), value);
      assert.equal(host.stats().live_values, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
