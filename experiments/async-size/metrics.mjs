import assert from "node:assert/strict";
export function account({ runtime, declarations, container = null }) {
  const files = [
    ...runtime,
    ...declarations,
    ...(container ? [container] : []),
  ];
  assert.equal(
    new Set(files.map((f) => f.path)).size,
    files.length,
    "each artifact has exactly one size category",
  );
  const sum = (list) => list.reduce((n, f) => n + f.sizes.raw, 0);
  return {
    runtime: Object.fromEntries(
      ["raw", "gzip", "brotli"].map((k) => [
        k,
        runtime.reduce((n, f) => n + f.sizes[k], 0),
      ]),
    ),
    wasm_bytes: sum(runtime.filter((f) => f.path.endsWith(".wasm"))),
    js_bytes: sum(runtime.filter((f) => /\.m?js$/.test(f.path))),
    declaration_bytes: sum(declarations),
    component_bytes: container?.sizes.raw ?? 0,
    payload_bytes: sum(files),
  };
}
export function growth(sync, async) {
  return {
    wasm_bytes: async.wasm_bytes - sync.wasm_bytes,
    js_bytes: async.js_bytes - sync.js_bytes,
    runtime_bytes: async.runtime.raw - sync.runtime.raw,
  };
}
