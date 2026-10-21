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
export function verifyTypedSizeBudget(entries) {
  return ["std", "no_std"].map((mode) => {
    const find = (backend) =>
      entries.find(
        (e) =>
          e.backend === backend &&
          e.mode === mode &&
          e.workload === "async" &&
          e.allocator === "taraba",
      );
    const manual = find("future"),
      typed = find("future-typed");
    assert.ok(
      manual && typed,
      `missing typed/manual Core size control: ${mode}`,
    );
    assert.ok(
      typed.wasm_bytes <= manual.wasm_bytes,
      `${mode}: typed bindings increased Wasm size`,
    );
    assert.ok(
      typed.js_bytes <= manual.js_bytes,
      `${mode}: typed bindings increased JavaScript size`,
    );
    return {
      mode,
      wasm_bytes: typed.wasm_bytes - manual.wasm_bytes,
      js_bytes: typed.js_bytes - manual.js_bytes,
    };
  });
}
