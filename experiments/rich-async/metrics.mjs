import assert from "node:assert/strict";
export function verifySizeBudget(entries, baseline) {
  return ["taraba", "wit-bindgen"].flatMap((backend) =>
    ["std", "no_std"].map((mode) => {
      const current = entries.find(
          (e) => e.backend === backend && e.mode === mode,
        ),
        previous = baseline.find(
          (e) => e.backend === backend && e.mode === mode,
        );
      assert.ok(
        current && previous,
        `missing rich async size row: ${backend}/${mode}`,
      );
      assert.ok(
        current.wasm_bytes <= previous.wasm_bytes + 64,
        `${backend}/${mode}: Wasm exceeded its size budget (+64 B portability allowance)`,
      );
      assert.ok(
        current.js_bytes <= previous.js_bytes,
        `${backend}/${mode}: JS exceeded its size budget`,
      );
      return {
        backend,
        mode,
        wasm_growth: current.wasm_bytes - previous.wasm_bytes,
        js_growth: current.js_bytes - previous.js_bytes,
      };
    }),
  );
}
