import assert from "node:assert/strict";

export function asyncCases(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024)
    throw Error("invalid async capacity");
  const inputs = [
    [2147483647, 1],
    [-2147483648, -1],
    [0, 0],
    [13, -29],
    [2147483647, 2147483647],
    [-1234567, 7654321],
  ];
  return Array.from({ length: 3 }, (_, batch) =>
    Array.from({ length: capacity }, (_, task) => {
      const args = inputs[(task + batch) % inputs.length];
      const intermediate = (args[0] + args[1]) | 0;
      return {
        batch,
        task,
        args,
        intermediate,
        expected: (intermediate + 1) | 0,
      };
    }),
  );
}

export function validateAsyncRun(batches, run) {
  const cases = batches.flat(),
    count = cases.length;
  assert.equal(run.engine, "wasmtime 47.0.4");
  assert.equal(run.all_passed, true);
  assert.equal(run.requests, count * 2, "both host requests must execute");
  assert.equal(run.completions, count * 2, "both requests must complete");
  assert.equal(run.first_poll_pending, count, "first await must suspend");
  assert.equal(run.second_poll_pending, count, "second await must suspend");
  assert.equal(run.polls, batches.length * 3, "host may poll only after wake");
  assert.equal(run.protocol_checks, count * 5 + batches.length * 3);
  assert.equal(run.checks.length, count);
  cases.forEach((c, i) =>
    assert.deepEqual(run.checks[i], { ...c, actual: c.expected }),
  );
}
