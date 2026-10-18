import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instantiate } from "./host.mjs";

test("trampolines preserve f64, zero arguments and void results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taraba-stack-"));
  try {
    writeFileSync(
      `${dir}/raw.wat`,
      `(module
      (import "app" "echo" (func $echo (param f64) (result f64)))
      (import "app" "note" (func $note))
      (memory (export "memory") 1 16)
      (global (export "__stack_pointer") (mut i32) (i32.const 65536))
      (global (export "__stack_low") i32 (i32.const 0))
      (global (export "__stack_high") i32 (i32.const 65536))
      (func (export "run") (param f64) (result f64) local.get 0 call $echo)
      (func (export "notify") call $note))`,
    );
    execFileSync(".cache/toolchains/binaryen-version_133/bin/wasm-as", [
      `${dir}/raw.wat`,
      "-o",
      `${dir}/raw.wasm`,
    ]);
    execFileSync("experiments/jspi-concurrent/target/debug/transform", [
      `${dir}/raw.wasm`,
      `${dir}/wrapped.wasm`,
    ]);
    let notes = 0;
    const host = await instantiate(readFileSync(`${dir}/wrapped.wasm`), {
      bindings: {
        echo: async (v) => v,
        note: async () => {
          notes++;
        },
      },
    });
    const values = [-0, NaN, Infinity, -Infinity, 1.25];
    const result = await Promise.all(values.map((v) => host.call("run", v)));
    assert.ok(result.every((v, i) => Object.is(v, values[i])));
    assert.equal(await host.call("notify"), undefined);
    assert.equal(notes, 1);
    assert.equal(host.stats().roots, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
