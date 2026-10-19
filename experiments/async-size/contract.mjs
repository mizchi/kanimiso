import assert from "node:assert/strict";

// These profiles share a wasm-bindgen Promise boundary. Other backends have
// separate fatal/typed-error contracts and are deliberately not checked here.
export async function verifyPromiseFailures(factory) {
  for (const step of [0, 1]) {
    const reason = Object.freeze({ rejected_await: step });
    const run = await factory((a, b) =>
      (step === 0 ? a === 7 && b === 9 : a === 16 && b === 1)
        ? Promise.reject(reason)
        : Promise.resolve((a + b) | 0),
    );
    const [failed, other] = await Promise.allSettled([run(7, 9), run(20, 21)]);
    assert.equal(failed.status, "rejected");
    assert.equal(failed.reason, reason, "Promise rejection identity changed");
    assert.deepEqual(other, { status: "fulfilled", value: 42 });
    assert.equal(
      await run(1, 2),
      4,
      "executor must be reusable after rejection",
    );
  }
  return {
    rejected_awaits: 2,
    identity_preserved: true,
    concurrent_successes: 2,
    reusable: true,
  };
}

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
