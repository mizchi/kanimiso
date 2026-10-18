import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";

for (const debug of [false, true])
  test(`runtime error codes are stable and ${debug ? "debug descriptions remain" : "release descriptions are absent"}`, async () => {
    const b = await esbuild.build({
      entryPoints: ["src/errors.mjs"],
      bundle: true,
      minify: true,
      format: "esm",
      platform: "neutral",
      write: false,
      define: { __JSRT_DEBUG_ERRORS__: String(debug) },
    });
    const code = b.outputFiles[0].text;
    const { runtimeError } = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );

    const e = runtimeError("RT01", RangeError);
    assert.ok(e instanceof RangeError);
    assert.equal(e.code, "RT01");
    assert.equal(e.message, debug ? "invalid token range" : "RT01");
    assert.equal(
      runtimeError("RT06", Error, "start").message,
      debug ? "missing export: start" : "RT06",
    );
    assert.equal(runtimeError("RT09").code, "RT09");
    assert.equal(
      code.includes("invalid token range"),
      debug,
      "release bundle must omit the message table",
    );
  });

for (const debug of [false, true])
  test(`coded host preserves typed errors, OOM code and external identity (debug=${debug})`, async () => {
    const b = await esbuild.build({
      entryPoints: ["src/host.mjs"],
      bundle: true,
      minify: true,
      format: "esm",
      platform: "neutral",
      write: false,
      define: { __JSRT_DEBUG_ERRORS__: String(debug) },
    });
    const { createHost } = await import(
      `data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString("base64")}`
    );
    assert.throws(
      () => createHost({ tokens: { first: 0 } }),
      (e) => e instanceof RangeError && e.code === "RT01",
    );
    assert.throws(
      () => createHost({ maxValues: 0 }),
      (e) => e instanceof RangeError && e.code === "RT02",
    );
    const h = createHost();
    assert.throws(
      () => h.call("rt_poll", 1),
      (e) => e.code === "RT11",
    );
    assert.equal(
      h.stats().dead,
      false,
      "private ABI refusal does not poison the instance",
    );
    h.attach({ memory: { buffer: new ArrayBuffer(0) } });
    let fatal;
    assert.throws(
      () => h.call("absent"),
      (e) => {
        fatal = e;
        return (
          e.code === "RT06" &&
          e.message === (debug ? "missing export: absent" : "RT06")
        );
      },
    );
    await assert.rejects(h.promise("another"), (e) => e === fatal);
    assert.equal(h.stats().dead, true);
    const external = Object.assign(new TypeError("provider failed"), {
      code: "PROVIDER_CODE",
    });
    const other = createHost();
    other.attach({
      fail() {
        throw external;
      },
    });
    assert.throws(
      () => other.call("fail"),
      (e) => e === external,
    );
    assert.equal(external.code, "PROVIDER_CODE");
    assert.equal(external.message, "provider failed");
    const oom = createHost({ maxValues: 1 });
    oom.root({});
    assert.throws(
      () => oom.root({}),
      (e) =>
        e instanceof RangeError &&
        e.name === "WasmOutOfMemoryError" &&
        e.code === "ERR_WASM_OOM" &&
        e.message === (debug ? "Wasm allocation failed" : "RT03"),
    );
  });
