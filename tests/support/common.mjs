import assert from "node:assert/strict";
import { asyncCases } from "./async-contract.mjs";

export async function verifyCommon(api, { workload }) {
  let checks = 0,
    tasks = 0;
  const actual = [];
  for (const [a, b] of [
    [0, 0],
    [13, -29],
    [2147483647, 1],
    [-2147483648, -1],
  ]) {
    assert.equal(api.add(a, b), (a + b) | 0, "addition");
    checks++;
  }
  const asyncWork = ["async", "combined"].includes(workload);
  const recordWork = ["records", "combined"].includes(workload);
  const mapWork = ["maps", "combined"].includes(workload);
  for (const name of [
    ...(asyncWork ? ["start", "awaitValue", "spawnEmpty"] : []),
    ...(recordWork ? ["recordNew", "recordUpdate"] : []),
    ...(mapWork ? ["mapRoundtrip"] : []),
    ...(workload === "combined" ? ["recordAfter"] : []),
  ])
    assert.equal(typeof api[name], "function", `missing ${name}`);
  if (asyncWork) {
    for (const capacity of [1, 16, 128, 1024])
      for (const cases of asyncCases(capacity)) {
        const before = api.io?.requests.length;
        const promises = cases.map((c) => api.start(...c.args));
        if (api.io)
          assert.equal(
            api.io.requests.length,
            before,
            "no synchronous task poll",
          );
        const values = await Promise.all(promises);
        assert.deepEqual(
          values,
          cases.map((c) => c.expected),
        );
        actual.push({ capacity, batch: cases[0].batch, values });
        tasks += cases.length;
        checks += cases.length;
        if (api.io) {
          const expected = cases
            .flatMap((c) => [c.args, [c.intermediate, 1]])
            .map((v) => JSON.stringify(v))
            .sort();
          assert.deepEqual(
            api.io.requests
              .slice(before)
              .map((v) => JSON.stringify(v))
              .sort(),
            expected,
            "dependent I/O arguments",
          );
        }
      }
    assert.equal(await api.spawnEmpty(), undefined);
    checks++;
    const object = { identity: "same JS object" };
    assert.equal(await api.awaitValue(Promise.resolve(object)), object);
    checks++;
    const reason = { identity: "same rejection reason" };
    await assert.rejects(
      api.awaitValue(Promise.reject(reason)),
      (error) => error === reason,
    );
    checks++;
  }
  if (recordWork) {
    assert.deepEqual(api.recordNew(7), { amount: 7, version: 0 });
    checks++;
    const object = { amount: 2147483647, version: 9 };
    assert.equal(api.recordUpdate(object, 1), 0);
    assert.deepEqual(object, { amount: -2147483648, version: 10 });
    checks++;
    object.amount = "bad";
    assert.equal(api.recordUpdate(object, 1), -2);
    checks++;
    assert.equal(
      api.recordUpdate(
        {
          get amount() {
            throw Error("getter");
          },
          version: 0,
        },
        1,
      ),
      -3,
    );
    checks++;
    const frozen = Object.freeze({ amount: 5, version: 0 });
    assert.equal(api.recordUpdate(frozen, 1), -2);
    checks++;
  }
  if (mapWork)
    for (const [k, v] of [
      [0, 0],
      [-1, 123],
      [2147483647, -2147483648],
    ]) {
      assert.equal(api.mapRoundtrip(k, v), v);
      checks++;
    }
  if (workload === "combined") {
    const object = { amount: 10, version: 0 };
    let resolve;
    const wait = new Promise((r) => {
      resolve = r;
    });
    const result = api.recordAfter(object, wait);
    await Promise.resolve();
    object.amount = 100;
    resolve();
    assert.equal(await result, object);
    assert.equal(object.amount, 101);
    checks++;
  }
  return { all_passed: true, workload, checks, tasks, actual };
}
