import assert from "node:assert/strict";
import test from "node:test";
import { timeWitPair } from "../../tests/support/wit-contract.mjs";

test("paired timing warms both hosts equally and alternates sample order", async () => {
  const blocks = [];
  let calls = 0,
    ticks = 0;
  const factory = (id) => async () => async () => {
    if (calls++ % 4096 === 0) blocks.push(id);
    return 1;
  };
  const timing = await timeWitPair([factory(0), factory(1)], () => ticks++);
  const expected = [0, 1]; // 4096 warmup tasks per host, outside samples.
  for (let i = 0; i < 11; i++) expected.push(...(i % 2 ? [1, 0] : [0, 1]));
  assert.deepEqual(blocks, expected);
  assert.equal(calls, 24 * 4096);
  for (const result of timing) {
    assert.equal(result.samples.length, 11);
    assert.equal(result.tasks_per_sample, 4096);
    assert.equal(result.median, 1000 / 4096);
    assert.equal(result.min, result.max);
  }
});
