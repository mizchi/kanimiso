import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";
import { readFileSync } from "node:fs";
const messages = JSON.parse(readFileSync("src/error-codes.json", "utf8"));
const reference = (code) =>
  `https://github.com/mizchi/taraba/blob/main/docs/error-codes.md#${code.toLowerCase()}`;
const message = (code, debug) =>
  `${code}${debug ? `: ${messages[code]}` : ""} ${reference(code)}`;

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
    assert.equal(e.message, message("RT01", debug));
    assert.equal(runtimeError("RT06").message, message("RT06", debug));
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
        return e instanceof TypeError && e.code === undefined;
      },
    );
    await assert.rejects(
      Promise.resolve().then(() => h.call("another")),
      (e) => e === fatal,
    );
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
    oom.imports.jsrt.__root({});
    assert.throws(
      () => oom.imports.jsrt.__root({}),
      (e) =>
        e instanceof RangeError &&
        e.name === "WasmOutOfMemoryError" &&
        e.code === "ERR_WASM_OOM" &&
        e.message === message("RT03", debug),
    );
  });

for (const profile of ["", "-jspi"]) {
  for (const debug of [false, true]) {
    test(`${profile || "future"} emitted ${debug ? "debug" : "release"} errors link to the code reference`, async () => {
      const file = `../crates/taraba-cli/assets/taraba${profile}${debug ? "-debug" : ""}.mjs`;
      const { createHost } = await import(file);
      const host = createHost();
      host.attach({});
      assert.throws(
        () => host.attach({}),
        (error) => {
          assert.equal(error.code, "RT12");
          assert.equal(error.message, message("RT12", debug));
          return true;
        },
      );
      if (!debug) {
        const source = readFileSync(new URL(file, import.meta.url), "utf8");
        for (const text of Object.values(messages))
          assert.ok(!source.includes(text), text);
      }
    });
  }
}

test("every current error code has a documented URL anchor and description", () => {
  const page = readFileSync("docs/error-codes.md", "utf8");
  for (const [code, text] of Object.entries(messages)) {
    assert.match(page, new RegExp(`^## ${code}$`, "m"));
    assert.ok(page.includes(text), code);
    assert.equal(new URL(reference(code)).hash, `#${code.toLowerCase()}`);
  }
});
