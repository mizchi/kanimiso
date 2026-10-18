import assert from "node:assert/strict";
import test from "node:test";
import { Gates } from "./gates.mjs";

test("wake before park is latched and duplicate wake is coalesced", async () => {
  const g = new Gates(),
    id = g.open_();
  g.signal_(id);
  g.signal_(id);
  await g.park_(id);
  let done = false;
  const next = g.park_(id).then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  g.signal_(id);
  await next;
  g.close_(id);
  assert.equal(g.stats_().gates, 0);
});
test("wake after park resumes exactly one wait; stale ids never wake new gates", async () => {
  const g = new Gates(),
    id = g.open_();
  let count = 0;
  const p = g.park_(id).then(() => count++);
  g.signal_(id);
  g.signal_(id);
  await p;
  assert.equal(count, 1);
  g.close_(id);
  const other = g.open_();
  assert.notEqual(other, id);
  g.signal_(id);
  let done = false;
  const q = g.park_(other).then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  g.signal_(other);
  await q;
  g.close_(other);
});
test("retiring host rejects parked calls with exact first fatal reason", async () => {
  const g = new Gates(),
    id = g.open_(),
    reason = undefined;
  const p = g.park_(id);
  g.retire_(reason);
  await assert.rejects(p, (e) => e === reason);
  assert.equal(g.stats_().gates, 0);
  assert.equal(g.stats_().dead, true);
  assert.throws(
    () => g.open_(),
    (e) => e === reason,
  );
});
test("park twice is rejected, close retires a wait, monotonic IDs never wrap", async () => {
  const g = new Gates(),
    id = g.open_(),
    p = g.park_(id);
  assert.throws(() => g.park_(id), /already parked/);
  g.close_(id);
  await assert.rejects(p, /closed/);
  g.signal_(id);
  assert.throws(() => g.park_(id), /unknown/);
  const limited = new Gates(2);
  limited.close_(limited.open_());
  limited.close_(limited.open_());
  assert.throws(() => limited.open_(), /exhausted/);
});
