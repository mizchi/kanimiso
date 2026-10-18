// Portable to V8 and JavaScriptCore. All profiles run this exact contract.
const equal = (a, b, message) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(message);
};
const flush = async (condition) => {
  for (let i = 0; i < 200 && !condition(); i++)
    await (typeof setTimeout === "function"
      ? new Promise((r) => setTimeout(r, 1))
      : Promise.resolve());
  if (!condition()) throw Error("async progress did not occur");
};
export async function verifyWit(factory, batches) {
  let add = (a, b) => Promise.resolve((a + b) | 0);
  const calls = [];
  const run = await factory((a, b) => {
    calls.push([a, b]);
    return add(a, b);
  });
  let tasks = 0;
  for (const cases of batches) {
    const before = calls.length;
    const actual = await Promise.all(cases.map((c) => run(...c.args)));
    equal(
      actual,
      cases.map((c) => c.expected),
      "wrong signed i32 results",
    );
    equal(
      calls
        .slice(before)
        .map((v) => JSON.stringify(v))
        .sort(),
      cases
        .flatMap((c) => [c.args, [c.intermediate, 1]])
        .map((v) => JSON.stringify(v))
        .sort(),
      "different host I/O or algorithm",
    );
    tasks += cases.length;
  }
  const controlled = [],
    resolvers = [];
  add = (a, b) => {
    controlled.push([a, b]);
    return new Promise((r) => resolvers.push(r));
  };
  let done = false;
  const pending = run(7, 9).then((v) => {
    done = true;
    return v;
  });
  await flush(() => controlled.length === 1);
  equal(done, false, "first await did not suspend");
  equal(controlled, [[7, 9]], "first host call");
  resolvers[0](16);
  await flush(() => controlled.length === 2);
  equal(done, false, "second await did not suspend");
  equal(
    controlled,
    [
      [7, 9],
      [16, 1],
    ],
    "second host call",
  );
  resolvers[1](17);
  equal(await pending, 17, "controlled result");
  return {
    all_passed: true,
    tasks,
    host_requests: tasks * 2,
    controlled_io: controlled,
    actual_suspensions: 2,
  };
}
export async function timeWit(factory, clock, rounds = 11) {
  const run = await factory((a, b) => Promise.resolve((a + b) | 0));
  const batch = async () => {
    const result = await Promise.all(
      Array.from({ length: 512 }, (_, i) => run(i, -i)),
    );
    if (!result.every((v) => v === 1)) throw Error("benchmark result mismatch");
  };
  for (let i = 0; i < 8; i++) await batch();
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const t = clock();
    for (let j = 0; j < 8; j++) await batch();
    samples.push(((clock() - t) * 1000) / 4096);
  }
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    unit: "microseconds/task (two host awaits)",
    tasks_per_sample: 4096,
    samples,
    median: sorted[Math.floor(rounds / 2)],
    min: sorted[0],
    max: sorted.at(-1),
  };
}
