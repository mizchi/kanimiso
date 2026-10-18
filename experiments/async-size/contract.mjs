import assert from "node:assert/strict";

export async function verifySync(factory, batches) {
  const calls = [];
  const run = await factory((a, b) => {
    calls.push([a, b]);
    return (a + b) | 0;
  });
  let tasks = 0;
  for (const batch of batches)
    for (const c of batch) {
      const before = calls.length;
      assert.equal(await run(...c.args), c.expected);
      assert.deepEqual(calls.slice(before), [c.args, [c.intermediate, 1]]);
      tasks++;
    }
  return {
    all_passed: true,
    tasks,
    host_requests: calls.length,
    actual_suspensions: 0,
  };
}
export async function verifyEmbassyCapacity(factory) {
  let release;
  const gate = new Promise((r) => (release = r)),
    calls = [];
  const run = await factory(async (a, b) => {
    calls.push([a, b]);
    await gate;
    return (a + b) | 0;
  });
  const results = Array.from({ length: 1025 }, (_, i) =>
    Promise.resolve(run(i, 1)).then(
      (v) => ({ ok: v }),
      (e) => ({ err: e }),
    ),
  );
  for (let i = 0; i < 200; i++) await Promise.resolve();
  assert.equal(
    calls.length,
    1024,
    "the documented static pool must admit 1024 pending tasks",
  );
  assert.deepEqual(await results[1024], { err: -5 });
  release();
  const settled = await Promise.all(results);
  assert.equal(settled.filter((v) => Object.hasOwn(v, "ok")).length, 1024);
  for (let i = 0; i < 1024; i++) assert.equal(settled[i].ok, i + 2);
  assert.equal(await run(20, 21), 42, "pool must be reusable after exhaustion");
  return { capacity: 1024, excess_rejected: 1, reusable: true };
}
