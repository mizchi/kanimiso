import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instantiate } from "../dist/index.mjs";

test("WIT resource ownership supports matching import/export names and explicit drop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kanimiso-consumer-"));
  try {
    writeFileSync(
      `${dir}/raw.wat`,
      '(module (import "$root" "identity" (func $id (param i32) (result i32))) (import "test:consumer/js" "[resource-drop]value" (func $drop (param i32))) (memory (export "memory") 4 16) (func (export "identity") (param i32) (result i32) local.get 0 call $id) (func (export "discard") (param i32) local.get 0 call $drop))',
    );
    execFileSync(".cache/toolchains/binaryen-version_133/bin/wasm-as", [
      `${dir}/raw.wat`,
      "-o",
      `${dir}/raw.wasm`,
    ]);
    writeFileSync(
      `${dir}/app.wit`,
      `package test:consumer; interface js {resource value;} world app {import js; use js.{value}; import identity: func(v:value)->value; export identity: func(v:value)->value; export discard: func(v:value);}`,
    );
    execFileSync(process.execPath, [
      "tools/build-wasm.mjs",
      `${dir}/raw.wasm`,
      "--wit",
      `${dir}/app.wit`,
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
      host.call("discard", value);
      assert.equal(
        host.stats().live_values,
        0,
        "WIT resource-drop must release the transferred JS root",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
