import assert from "node:assert/strict";
import test from "node:test";
import { createResources } from "../crates/taraba-cli/src/templates/resources.mjs";
test("resource ownership transfers, borrowed leases and explicit disposal are exclusive", () => {
  const resources = createResources();
  let drops = 0;
  const value = {
    text: "x",
    [Symbol.dispose]() {
      drops++;
    },
  };
  const lease = resources.wrap(value);
  resources.begin(lease);
  assert.throws(
    () => lease[Symbol.dispose](),
    (e) => e.code === "RS02",
  );
  assert.throws(
    () => resources.take(lease),
    (e) => e.code === "RS02",
  );
  resources.end(lease);
  resources.take(lease);
  assert.equal(resources.peek(lease), value);
  assert.throws(
    () => lease[Symbol.dispose](),
    (e) => e.code === "RS02",
  );
  resources.give(lease);
  lease[Symbol.dispose]();
  lease[Symbol.dispose]();
  assert.equal(drops, 1);
  assert.throws(
    () => resources.take(lease),
    (e) => e.code === "RS01",
  );
});
test("host ownership can be returned and foreign instance handles are rejected", () => {
  const a = createResources(),
    b = createResources(),
    v = { [Symbol.dispose]() {} };
  const lease = a.wrap(v);
  assert.throws(
    () => a.wrap(v),
    (e) => e.code === "RS03",
  );
  assert.throws(
    () => b.take(lease),
    (e) => e.code === "RS01",
  );
  assert.equal(a.toHostOwn(lease), v);
  assert.throws(
    () => a.peek(lease),
    (e) => e.code === "RS01",
  );
  const next = a.wrap(v);
  a.take(next);
  a.drop(next);
  assert.throws(
    () => a.give(next),
    (e) => e.code === "RS01",
  );
});

test("host shutdown releases Rust owners and returns JS borrows without disposing JS owners", () => {
  const r = createResources();
  let disposed = 0;
  const make = () => ({
    [Symbol.dispose]() {
      disposed++;
    },
  });
  const owned = r.wrap(make()),
    borrowed = r.wrap(make());
  r.take(owned);
  r.begin(borrowed);
  r.close();
  r.close();
  assert.equal(disposed, 1);
  borrowed[Symbol.dispose]();
  assert.equal(disposed, 2);
  assert.throws(
    () => r.peek(owned),
    (e) => e.code === "RS01",
  );
});

test("shutdown completes every resource cleanup and preserves even falsy thrown values", () => {
  for (const error of [undefined, null, false, 0, ""]) {
    const r = createResources();
    let drops = 0;
    r.take(
      r.wrap({
        [Symbol.dispose]() {
          drops++;
          throw error;
        },
      }),
    );
    r.take(
      r.wrap({
        [Symbol.dispose]() {
          drops++;
        },
      }),
    );
    let caught = false;
    try {
      r.close();
    } catch (value) {
      caught = true;
      assert.equal(value, error);
    }
    assert.equal(caught, true);
    assert.equal(drops, 2);
    r.close();
  }
});
