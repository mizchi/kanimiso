import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import esbuild from "esbuild";
import { verifyWit } from "./support/wit-contract.mjs";
import { asyncCases } from "./support/async-contract.mjs";
const built = await esbuild.build({
  entryPoints: ["src/jspi.mjs"],
  bundle: true,
  format: "esm",
  write: false,
  define: { __JSRT_DEBUG_ERRORS__: "true" },
});
const { instantiate } = await import(
  "data:text/javascript;base64," +
    Buffer.from(built.outputFiles[0].text).toString("base64")
);
const dir = mkdtempSync(join(tmpdir(), "kanimiso-jspi-"));
const wasm = (wat) => {
  writeFileSync(`${dir}/raw.wat`, wat);
  execFileSync(".cache/toolchains/binaryen-version_133/bin/wasm-as", [
    `${dir}/raw.wat`,
    "-o",
    `${dir}/raw.wasm`,
  ]);
  return readFileSync(`${dir}/raw.wasm`);
};
const bytes =
  wasm(`(module (import "app" "add" (func $add (param i32 i32) (result i32))) (memory (export "memory") 1)
 (func (export "run") (param i32 i32) (result i32) local.get 0 local.get 1 call $add i32.const 1 call $add)
 (func (export "held") (param i32 i32) (result i32) i32.const 0 local.get 0 i32.store local.get 0 local.get 1 call $add i32.const 0 i32.load i32.add)
 (func (export "trap") (param i32 i32) (result i32) local.get 0 local.get 1 call $add drop unreachable)
)`);
rmSync(dir, { recursive: true, force: true });
const tick = async (condition) => {
  for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve();
  assert.ok(condition());
};

test("JSPI executes the frozen two-await computation and controlled suspensions", async () => {
  const result = await verifyWit(async (add) => {
    const h = await instantiate(bytes, { bindings: { add } });
    return (...a) => h.promise("run", ...a);
  }, [1, 16, 128, 1024].flatMap(asyncCases));
  assert.equal(result.tasks, 3507);
});
test("serialized JSPI entry protects memory spills across suspension", async () => {
  const pending = [];
  let active = 0,
    peak = 0;
  const h = await instantiate(bytes, {
    bindings: {
      add: (a, b) => {
        peak = Math.max(peak, ++active);
        return new Promise((r) =>
          pending.push(() => {
            active--;
            r((a + b) | 0);
          }),
        );
      },
    },
  });
  const result = Promise.all(
    Array.from({ length: 16 }, (_, i) => h.call("held", i, 10)),
  );
  for (let i = 0; i < 16; i++) {
    await tick(() => pending.length > 0);
    pending.pop()();
  }
  assert.deepEqual(
    await result,
    Array.from({ length: 16 }, (_, i) => i * 2 + 10),
  );
  assert.equal(peak, 1);
  assert.deepEqual(h.stats(), {
    calls: 16,
    completions: 16,
    queued: 0,
    dead: false,
  });
});
test("host rejection closes the instance with the first reason and rejects queued calls", async () => {
  const reason = { failure: 1 };
  let calls = 0;
  const h = await instantiate(bytes, {
    bindings: {
      add: () => {
        calls++;
        return Promise.reject(reason);
      },
    },
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => h.promise("run", 1, 2).catch((e) => e)),
  );
  assert.ok(results.every((e) => e === reason));
  assert.equal(calls, 1);
  assert.equal(h.stats().dead, true);
  await assert.rejects(h.promise("run", 1, 2), (e) => e === reason);
});
test("a Wasm trap closes the instance after JSPI resumption", async () => {
  const h = await instantiate(new WebAssembly.Module(bytes), {
    bindings: { add: async (a, b) => (a + b) | 0 },
  });
  let reason;
  await assert.rejects(h.promise("trap", 1, 2), (e) => {
    reason = e;
    return e instanceof WebAssembly.RuntimeError;
  });
  await assert.rejects(h.promise("run", 1, 2), (e) => e === reason);
});
test("invalid calls and invalid binding configuration are rejected", async () => {
  await assert.rejects(instantiate(bytes, { bindings: { add: 1 } }), TypeError);
  const h = await instantiate(bytes, {
    bindings: { add: async (a, b) => (a + b) | 0 },
  });
  await assert.rejects(h.call("missing"), /export/);
  await assert.rejects(h.call("rt_poll"), /runtime|private/);
  assert.equal(h.stats().dead, false);
  assert.equal(await h.promise("run", 20, 21), 42);
});
test("unsupported JSPI engines are rejected without a compatibility fallback", async () => {
  const original = WebAssembly.promising;
  try {
    WebAssembly.promising = undefined;
    await assert.rejects(
      instantiate(bytes),
      (e) => e instanceof TypeError && e.message.includes("JSPI"),
    );
  } finally {
    WebAssembly.promising = original;
  }
});
