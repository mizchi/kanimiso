import assert from "node:assert/strict";
import test from "node:test";
import { Gates } from "./gates.mjs";

test("wake before park is latched and duplicate wake is coalesced", async () => {
  const g = new Gates(),
    id = g.open();
  g.signal(id);
  g.signal(id);
  await g.park(id);
  let done = false;
  const next = g.park(id).then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  g.signal(id);
  await next;
  g.close(id);
  assert.equal(g.stats().gates, 0);
});
test("wake after park resumes exactly one wait; stale ids never wake new gates", async () => {
  const g = new Gates(),
    id = g.open();
  let count = 0;
  const p = g.park(id).then(() => count++);
  g.signal(id);
  g.signal(id);
  await p;
  assert.equal(count, 1);
  g.close(id);
  const other = g.open();
  assert.notEqual(other, id);
  g.signal(id);
  let done = false;
  const q = g.park(other).then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  g.signal(other);
  await q;
  g.close(other);
});
test("retiring host rejects parked calls with exact first fatal reason", async () => {
  const g = new Gates(),
    id = g.open(),
    reason = undefined;
  const p = g.park(id);
  g.retire(reason);
  await assert.rejects(p, (e) => e === reason);
  assert.equal(g.stats().gates, 0);
  assert.equal(g.stats().dead, true);
  assert.throws(
    () => g.open(),
    (e) => e === reason,
  );
});
test("park twice is rejected, close retires a wait, monotonic IDs never wrap", async () => {
  const g = new Gates(),
    id = g.open(),
    p = g.park(id);
  assert.throws(() => g.park(id), /already parked/);
  g.close(id);
  await assert.rejects(p, /closed/);
  g.signal(id);
  assert.throws(() => g.park(id), /unknown/);
  const limited = new Gates(2);
  limited.close(limited.open());
  limited.close(limited.open());
  assert.throws(() => limited.open(), /exhausted/);
});
