import assert from "node:assert/strict";
import test from "node:test";
import { inspectScheduling } from "./support/scheduling.mjs";

// The same external I/O controller must distinguish serialization from independent tasks.
const factory = (serial) => async (add) => {
  const compute = async (a, b) => add(await add(a, b), 1);
  let tail = Promise.resolve();
  return (a, b) => {
    if (!serial) return compute(a, b);
    const result = tail.then(() => compute(a, b));
    tail = result.catch(() => {});
    return result;
  };
};

test("controlled I/O detects independent tasks and head-of-line blocking", async () => {
  for (const serial of [false, true]) {
    const result = await inspectScheduling(factory(serial));
    assert.deepEqual(
      result.started_before_release,
      serial
        ? [[10, 1]]
        : [
            [10, 1],
            [20, 2],
          ],
    );
    assert.deepEqual(result.completed_while_a_blocked, serial ? [] : ["B"]);
    assert.deepEqual(result.completion_order, serial ? ["A", "B"] : ["B", "A"]);
    assert.equal(result.tasks, 2);
    assert.equal(result.host_requests, 4);
  }
});

test("the controller rejects altered algorithms and stalled computations", async () => {
  await assert.rejects(inspectScheduling(async () => async () => 0));
  await assert.rejects(
    inspectScheduling(async () => () => new Promise(() => {})),
  );
});
