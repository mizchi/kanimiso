import assert from "node:assert/strict";
import test from "node:test";
import { account, growth } from "../experiments/async-size/metrics.mjs";

const file = (path, raw) => ({
  path,
  sizes: { raw, gzip: raw / 2, brotli: raw / 4 },
});
test("size accounting separates the Component container, declarations, and every runtime file", () => {
  const measured = account({
    runtime: [
      file("app.mjs", 100),
      file("snippets/io.js", 20),
      file("app.core.wasm", 40),
    ],
    declarations: [file("app.d.ts", 16)],
    container: file("app.component.wasm", 80),
  });
  assert.equal(measured.runtime.raw, 160);
  assert.equal(measured.runtime.gzip, 80);
  assert.equal(measured.wasm_bytes, 40);
  assert.equal(measured.js_bytes, 120);
  assert.equal(measured.declaration_bytes, 16);
  assert.equal(measured.component_bytes, 80);
  assert.equal(measured.payload_bytes, 256);
});
test("containers cannot be counted again among runtime files", () => {
  assert.throws(() =>
    account({
      runtime: [file("app.component.wasm", 80)],
      declarations: [],
      container: file("app.component.wasm", 80),
    }),
  );
});
test("async growth uses its own synchronous baseline, including JS changes", () => {
  const base = account({
    runtime: [file("a.wasm", 40), file("a.mjs", 100)],
    declarations: [],
  });
  const async = account({
    runtime: [file("a.wasm", 60), file("a.mjs", 160)],
    declarations: [],
  });
  assert.deepEqual(growth(base, async), {
    wasm_bytes: 20,
    js_bytes: 60,
    runtime_bytes: 80,
  });
});
