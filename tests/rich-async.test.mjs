import assert from "node:assert/strict";
import test from "node:test";
import {
  input,
  expected,
  verify,
  transform,
} from "../experiments/rich-async/contract.mjs";

test("rich async contract checks copies, byte wrapping and domain errors", async () => {
  assert.deepEqual(expected(input(0)), { tag: "err", val: "invalid-id" });
  assert.deepEqual(expected(input(1, 1, "denied")), {
    tag: "err",
    val: "host-denied",
  });
  assert.equal(expected(input(0xffffffff, 0, "")).val.id, 1);
  const report = await verify(async (host) => ({
    run: async (packet) => {
      let value = structuredClone(packet);
      if (value.id === 0) return { tag: "err", val: "invalid-id" };
      for (let step = 0; step < 2; step++) {
        value.label += "/rust";
        for (let i = 0; i < value.payload.length; i++)
          value.payload[i] = (value.payload[i] + i + step) & 255;
        const result = await host(value);
        if (result.tag === "err") return result;
        value = result.val;
        value.id = (value.id + 1) >>> 0;
      }
      return { tag: "ok", val: value };
    },
  }));
  assert.equal(report.cases, 216);
  assert.equal(transform(input(7)).val.payload[0], 7 ^ 0x5a);
});

test("rich async contract detects a broken guest algorithm", async () => {
  await assert.rejects(
    verify(async () => ({ run: async (value) => ({ tag: "ok", val: value }) })),
    assert.AssertionError,
  );
});

test("size regression gate accounts for all backends/modes and does not gate noisy timings", async () => {
  const { verifySizeBudget } =
    await import("../experiments/rich-async/metrics.mjs");
  const rows = ["taraba", "wit-bindgen"].flatMap((backend) =>
    ["std", "no_std"].map((mode) => ({
      backend,
      mode,
      wasm_bytes: 1000,
      js_bytes: 1000,
    })),
  );
  assert.equal(verifySizeBudget(rows, rows).length, 4);
  const next = structuredClone(rows);
  next[0].wasm_bytes += 65;
  assert.throws(() => verifySizeBudget(next, rows), /Wasm exceeded/);
  next[0].wasm_bytes -= 65;
  next[0].js_bytes++;
  assert.throws(() => verifySizeBudget(next, rows), /JS exceeded/);
  assert.throws(() => verifySizeBudget(rows.slice(1), rows), /missing/);
});
