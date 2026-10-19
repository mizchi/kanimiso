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
import { createLoader, withTestApi } from "./support/core-host.mjs";
const { createHost: runtimeCreateHost } = await import(
  "data:text/javascript;base64," +
    Buffer.from(built.outputFiles[0].text).toString("base64")
);
const createHost = (options, names = ["run", "held", "trap"]) =>
  withTestApi(runtimeCreateHost(options, names));
const instantiate = createLoader(runtimeCreateHost);
test("explicit JSPI host stays below the previous 1324-byte budget", async () => {
  const release = await esbuild.build({
    // The primary API does not need to ship the optional convenience loader.
    stdin: {
      contents: 'export {createHost} from "./src/jspi.mjs";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    define: { __JSRT_DEBUG_ERRORS__: "false" },
  });
  assert.ok(release.outputFiles[0].contents.length < 1324);
});
const dir = mkdtempSync(join(tmpdir(), "taraba-jspi-"));
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

test("explicit JSPI hosts work with native bytes, Module and streaming instantiation", async () => {
  for (const load of [
    async (imports) => (await WebAssembly.instantiate(bytes, imports)).instance,
    async (imports) =>
      WebAssembly.instantiate(new WebAssembly.Module(bytes), imports),
    async (imports) =>
      (
        await WebAssembly.instantiateStreaming(
          new Response(bytes, {
            headers: { "content-type": "application/wasm" },
          }),
          imports,
        )
      ).instance,
  ]) {
    const host = createHost({ bindings: { add: async (a, b) => (a + b) | 0 } });
    await assert.rejects(host.promise("run", 20, 21));
    const instance = await load(host.imports);
    host.attach(instance.exports);
    assert.equal(await host.promise("run", 20, 21), 42);
    assert.throws(() => host.attach(instance.exports));
    assert.equal(await host.promise("run", 1, 2), 4);
  }
});

test("attachment uses build-time export names without enumerating runtime values", async () => {
  const host = createHost({ bindings: { add: async (a, b) => a + b } }, [
    "run",
  ]);
  const raw = new WebAssembly.Instance(
    new WebAssembly.Module(bytes),
    host.imports,
  ).exports;
  host.attach(
    new Proxy(raw, {
      ownKeys() {
        throw Error("unexpected export enumeration");
      },
    }),
  );
  assert.equal(await host.promise("run", 20, 21), 42);
});

test("manual attachment preserves serialized suspension and first-fatal state", async () => {
  let release;
  const reason = { failure: "manual" };
  const host = createHost({
    bindings: {
      add: () =>
        new Promise((_, reject) => {
          release = () => reject(reason);
        }),
    },
  });
  const { instance } = await WebAssembly.instantiate(bytes, host.imports);
  host.attach(instance.exports);
  const first = host.promise("run", 1, 2);
  const queued = host.promise("run", 3, 4);
  await tick(() => release);
  assert.throws(() => host.attach(instance.exports));
  release();
  for (const result of await Promise.allSettled([first, queued])) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, reason);
  }
  assert.throws(() => host.attach(instance.exports));
  await assert.rejects(host.promise("run", 5, 6), (error) => error === reason);
});

test("a native attach failure cannot publish a partial dispatch table", async () => {
  const host = createHost({ bindings: { add: async (a, b) => a + b } }, [
    "run",
    "held",
  ]);
  const raw = new WebAssembly.Instance(
    new WebAssembly.Module(bytes),
    host.imports,
  ).exports;
  assert.throws(() => host.attach({ run: raw.run, held: () => 1 }), TypeError);
  assert.equal(host.stats().dead, false);
  host.attach(raw);
  assert.equal(await host.promise("run", 20, 21), 42);
  assert.throws(() => host.attach(raw));
});

test("explicit JSPI hosts pass the same 3507 arithmetic and controlled-I/O cases", async () => {
  const result = await verifyWit(async (add) => {
    const host = createHost({ bindings: { add } });
    host.attach(
      new WebAssembly.Instance(new WebAssembly.Module(bytes), host.imports)
        .exports,
    );
    return (...args) => host.promise("run", ...args);
  }, [1, 16, 128, 1024].flatMap(asyncCases));
  assert.equal(result.tasks, 3507);
});

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
    Array.from({ length: 16 }, (_, i) => h.promise("held", i, 10)),
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
test("fatal reason wins over queued private or missing exports after dispatch is cleared", async () => {
  for (const reason of [
    undefined,
    null,
    0,
    Object.freeze({ failure: "fatal" }),
  ]) {
    const h = await instantiate(bytes, {
      bindings: { add: () => Promise.reject(reason) },
    });
    const results = await Promise.allSettled([
      h.promise("run", 1, 2),
      h.promise("rt_poll"),
      h.promise("missing"),
    ]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason, reason);
    }
    assert.deepEqual(h.stats(), {
      calls: 1,
      completions: 0,
      queued: 0,
      dead: true,
    });
    const [later] = await Promise.allSettled([h.promise("cabi_realloc")]);
    assert.equal(later.status, "rejected");
    assert.equal(later.reason, reason);
    assert.equal(h.stats().queued, 0);
  }
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
test("unexpected native call errors preserve first-fatal identity", async () => {
  for (const bindings of [{ add: async (a, b) => a + b }, { add: 1 }]) {
    const host = await instantiate(bytes, { bindings });
    let fatal;
    await assert.rejects(
      host.promise(bindings.add === 1 ? "run" : "missing", 20, 21),
      (error) => {
        fatal = error;
        return error instanceof TypeError && error.code === undefined;
      },
    );
    assert.equal(host.stats().dead, true);
    await assert.rejects(host.promise("run", 1, 2), (error) => error === fatal);
  }
});
test("creating an empty host does not probe JSPI builtins", () => {
  const descriptors = Object.fromEntries(
    ["promising", "Suspending"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(WebAssembly, name),
    ]),
  );
  try {
    for (const name of Object.keys(descriptors)) {
      Object.defineProperty(WebAssembly, name, {
        configurable: true,
        get() {
          throw Error(`unexpected feature probe: ${name}`);
        },
      });
    }
    const host = createHost({}, []);
    host.attach({});
    assert.deepEqual(Object.keys(host.imports.app), []);
    assert.equal(host.stats().dead, false);
  } finally {
    for (const [name, descriptor] of Object.entries(descriptors))
      Object.defineProperty(WebAssembly, name, descriptor);
  }
});
