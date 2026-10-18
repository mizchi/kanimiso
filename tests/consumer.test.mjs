import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instantiate } from "../dist/index.mjs";

test("WIT resource ownership supports matching import/export names and explicit drop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taraba-consumer-"));
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
      "--future",
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

test("scalar WIT preserves the full u32 range and f64 values in both profiles", async () => {
  const { instantiate: instantiateJspi } = await import("../dist/jspi.mjs");
  const dir = mkdtempSync(join(tmpdir(), "taraba-scalars-"));
  try {
    writeFileSync(
      `${dir}/raw.wat`,
      `(module
      (import "$root" "echo" (func $u (param i32) (result i32)))
      (import "$root" "echo64" (func $f (param f64) (result f64)))
      (memory (export "memory") 4 16)
      (func (export "round") (param i32) (result i32) local.get 0 call $u)
      (func (export "round64") (param f64) (result f64) local.get 0 call $f))`,
    );
    execFileSync(".cache/toolchains/binaryen-version_133/bin/wasm-as", [
      `${dir}/raw.wat`,
      "-o",
      `${dir}/raw.wasm`,
    ]);
    writeFileSync(
      `${dir}/app.wit`,
      "package test:scalars; world app {import echo: func(v:u32)->u32; import echo64:func(v:f64)->f64; export round:func(v:u32)->u32; export round64:func(v:f64)->f64;}",
    );
    for (const jspi of [false, true]) {
      const output = `${dir}/${jspi ? "jspi" : "core"}.wasm`;
      execFileSync(process.execPath, [
        "tools/build-wasm.mjs",
        `${dir}/raw.wasm`,
        "--wit",
        `${dir}/app.wit`,
        "--output",
        output,
        ...(jspi ? [] : ["--future"]),
      ]);
      const observed = [];
      const factory = jspi ? instantiateJspi : instantiate;
      const host = await factory(readFileSync(output), {
        bindings: {
          echo: (v) => {
            observed.push(v);
            return v;
          },
          echo64: (v) => v,
        },
      });
      const values = [0, 1, 2147483647, 2147483648, 4294967295];
      for (const value of values)
        assert.equal(await host.promise("round", value), value);
      assert.deepEqual(observed, values);
      for (const value of [0, -0, 1.5, NaN, Infinity, -Infinity])
        assert.ok(Object.is(await host.promise("round64", value), value));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
