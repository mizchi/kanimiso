import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";
const bundle = await esbuild.build({
  entryPoints: ["src/regexp.mjs"],
  bundle: true,
  format: "esm",
  write: false,
  define: { __JSRT_DEBUG_ERRORS__: "false", __TARABA_STRINGS__: "false" },
});
const { regexpImports } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

test("RegExp borrows UTF-8 synchronously, survives memory growth and releases handles", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const api = regexpImports(() => memory);
  const put = (s) => {
    const bytes = new TextEncoder().encode(s);
    new Uint8Array(memory.buffer).set(bytes, 32);
    return [32, bytes.length];
  };
  const handle = api.compile(...put("^(?:蟹|🦀)+$"));
  assert.notEqual(handle, 0);
  for (let i = 0; i < 3; i++) assert.equal(api.test(handle, ...put("蟹🦀")), 1);
  assert.equal(api.test(handle, ...put("蟹x")), 0);
  memory.grow(1);
  assert.equal(api.test(handle, ...put("🦀")), 1);
  api.drop(handle);
  assert.throws(() => api.test(handle, ...put("蟹")));
  assert.equal(api.compile(...put("[")), 0);
  const next = api.compile(...put("^$"));
  assert.notEqual(next, handle, "released handle IDs must not be reused");
  assert.equal(api.test(next, ...put("")), 1);
  api.drop(next);
  const bom = api.compile(...put("\uFEFF"));
  assert.equal(api.test(bom, ...put("\uFEFF")), 1);
  assert.equal(
    api.test(bom, ...put("")),
    0,
    "UTF-8 decoding must preserve BOM",
  );
  api.drop(bom);
});

test("invalid UTF-8 bounds and unavailable memory do not become regex syntax errors", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const api = regexpImports(() => memory);
  assert.throws(() => api.compile(65535, 2), RangeError);
  new Uint8Array(memory.buffer)[0] = 255;
  assert.throws(() => api.compile(0, 1), TypeError);
  assert.throws(() => regexpImports(() => undefined).compile(0, 0));
});
