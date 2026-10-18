import assert from "node:assert/strict";
import { verifyCommon } from "./common.mjs";

export async function verifyPromises(api) {
  const common = await verifyCommon(api, { workload: "async" });
  let extra = 0;
  const flush = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
    assert.ok(
      predicate(),
      "Promise workflow did not reach expected suspension",
    );
  };
  const original = api.io.defer;
  const calls = [],
    resolvers = [];
  api.io.defer = (a, b) => {
    calls.push([a, b]);
    return new Promise((resolve) => resolvers.push(resolve));
  };
  let done = false;
  const task = api.start(7, 9).then((v) => {
    done = true;
    return v;
  });
  assert.equal(calls.length, 0, "spawn must defer polling");
  await flush(() => calls.length === 1);
  assert.deepEqual(calls, [[7, 9]]);
  assert.equal(done, false);
  resolvers[0](16);
  await flush(() => calls.length === 2);
  assert.deepEqual(calls, [
    [7, 9],
    [16, 1],
  ]);
  assert.equal(done, false);
  resolvers[1](17);
  assert.equal(await task, 17);
  extra += 6;
  for (const step of [1, 2]) {
    const reason = { step };
    let requests = 0;
    api.io.defer = (a, b) =>
      ++requests === step
        ? Promise.reject(reason)
        : Promise.resolve((a + b) | 0);
    await assert.rejects(api.start(7, 9), (e) => e === reason);
    assert.equal(requests, step);
    extra += 2;
  }
  api.io.defer = original;
  for (const value of [undefined, null, 123n, Symbol("identity"), () => 42]) {
    assert.equal(await api.awaitValue(Promise.resolve(value)), value);
    await assert.rejects(
      api.awaitValue(Promise.reject(value)),
      (e) => e === value,
    );
    extra += 2;
  }
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const d = api.diagnostics();
  if (d.live_values !== undefined) {
    assert.equal(d.live_values, 0);
    assert.equal(d.live_tasks, 0);
    assert.equal(d.live_waits, 0);
    assert.equal(d.dead, false);
  }
  return {
    common,
    extra_checks: extra,
    controlled_io: calls,
    all_passed: true,
  };
}
export async function verifyCapacity(api) {
  if (!api.capacity) return null;
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const results = Promise.allSettled(
    Array.from({ length: api.capacity + 1 }, () => api.awaitValue(pending)),
  );
  await Promise.resolve();
  const value = { capacity_probe: true };
  resolve(value);
  const outcomes = await results;
  assert.equal(
    outcomes.filter((o) => o.status === "fulfilled" && o.value === value)
      .length,
    api.capacity,
  );
  assert.deepEqual(
    outcomes.filter((o) => o.status === "rejected").map((o) => o.reason),
    [-5],
  );
  assert.equal(await api.spawnEmpty(), undefined, "pool reusable after Busy");
  const d = api.diagnostics();
  assert.equal(d.live_values, 0);
  assert.equal(d.live_tasks, 0);
  assert.equal(d.live_waits, 0);
  return {
    capacity: api.capacity,
    fulfilled: api.capacity,
    busy_rejections: 1,
    reused: true,
  };
}
