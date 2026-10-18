// Portable to V8, JavaScriptCore and workerd. No timers or elapsed-time assertions.
const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};
const equal = (actual, expected, message) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(message);
};

export async function inspectScheduling(factory) {
  const requests = [],
    completed = [],
    values = [],
    failures = [];
  const run = await factory(
    (a, b) =>
      new Promise((resolve) =>
        requests.push({ a, b, resolve, settled: false }),
      ),
  );
  const submit = (label, a, b) =>
    Promise.resolve(run(a, b)).then(
      (value) => {
        completed.push(label);
        values.push([label, value]);
      },
      (error) => {
        failures.push(error);
      },
    );
  const pending = [submit("A", 10, 1), submit("B", 20, 2)];
  await flush();
  const started = requests.map(({ a, b }) => [a, b]);
  const release = (predicate) => {
    for (const request of requests) {
      if (!request.settled && predicate(request)) {
        request.settled = true;
        request.resolve((request.a + request.b) | 0);
      }
    }
  };
  // Only B may finish. A's first I/O remains unresolved throughout this phase.
  for (let i = 0; i < 3; i++) {
    release(({ a }) => a >= 20);
    await flush();
  }
  const whileBlocked = [...completed];
  for (let i = 0; i < 8 && completed.length + failures.length < 2; i++) {
    release(() => true);
    await flush();
  }
  equal(failures.length, 0, "scheduling computation rejected");
  equal(completed.length, 2, "scheduling computation stalled");
  await Promise.all(pending);
  equal(
    values.sort(),
    [
      ["A", 12],
      ["B", 23],
    ],
    "scheduling results changed",
  );
  equal(
    requests.map(({ a, b }) => [a, b]).sort(),
    [
      [10, 1],
      [11, 1],
      [20, 2],
      [22, 1],
    ],
    "scheduling host I/O changed",
  );
  return {
    tasks: 2,
    host_requests: requests.length,
    started_before_release: started,
    completed_while_a_blocked: whileBlocked,
    completion_order: completed,
  };
}

export async function verifyScheduling(factory, { serialized }) {
  const result = await inspectScheduling(factory);
  equal(
    result.started_before_release,
    serialized
      ? [[10, 1]]
      : [
          [10, 1],
          [20, 2],
        ],
    "guest entry scheduling contract changed",
  );
  equal(
    result.completed_while_a_blocked,
    serialized ? [] : ["B"],
    "head-of-line blocking contract changed",
  );
  equal(
    result.completion_order,
    serialized ? ["A", "B"] : ["B", "A"],
    "completion order changed",
  );
  return result;
}
