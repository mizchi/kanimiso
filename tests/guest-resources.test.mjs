import test from "node:test";
import assert from "node:assert/strict";
import { createGuestResources } from "../crates/taraba-cli/src/templates/guest-resources.mjs";
test("guest resources enforce type/instance identity, borrowed disposal and one drop", () => {
  const dropped = [],
    r = createGuestResources((type, key) => dropped.push([type, key]));
  r.define("Counter", (self) => ({ read: () => r.begin(self, "Counter") }));
  const value = r.create("Counter", 65536);
  assert.equal(value.read(), 65536);
  assert.throws(
    () => value[Symbol.dispose](),
    (e) => e.code === "RS02",
  );
  assert.throws(
    () => r.take(value, "Other"),
    (e) => e.code === "RS01",
  );
  assert.throws(
    () => createGuestResources(() => {}).take(value, "Counter"),
    (e) => e.code === "RS01",
  );
  r.end(value);
  value[Symbol.dispose]();
  value[Symbol.dispose]();
  assert.deepEqual(dropped, [["Counter", 65536]]);
  assert.throws(
    () => r.begin(value, "Counter"),
    (e) => e.code === "RS01",
  );
});
test("ownership transfer invalidates the JS lease without dropping the Rust owner", () => {
  let drops = 0;
  const r = createGuestResources(() => drops++);
  r.define("Counter", () => ({}));
  const value = r.create("Counter", 42);
  assert.equal(r.take(value, "Counter"), 42);
  value[Symbol.dispose]();
  r.close();
  assert.equal(drops, 0);
});
test("close retires owners while outstanding borrows may finish, and stays idempotent", () => {
  let drops = 0;
  const r = createGuestResources(() => drops++);
  r.define("Counter", () => ({}));
  const a = r.create("Counter", 1);
  r.create("Counter", 2);
  r.begin(a, "Counter");
  r.close();
  assert.equal(drops, 2);
  r.end(a);
  r.close();
  assert.equal(drops, 2);
  assert.throws(
    () => r.create("Counter", 3),
    (e) => e.code === "RS01",
  );
});
test("fatal shutdown abandons remaining leases without entering poisoned Wasm", () => {
  let drops = 0;
  const r = createGuestResources(() => drops++);
  r.define("Counter", () => ({}));
  const a = r.create("Counter", 1);
  r.begin(a, "Counter");
  r.create("Counter", 2);
  r.close(true);
  a[Symbol.dispose]();
  r.close();
  assert.equal(drops, 0);
});
test("close drains all owners even when Drop throws a falsy exception", () => {
  let drops = 0;
  const r = createGuestResources(() => {
    drops++;
    throw undefined;
  });
  r.define("Counter", () => ({}));
  const a = r.create("Counter", 1),
    b = r.create("Counter", 2);
  let threw = false;
  try {
    r.close();
  } catch (error) {
    threw = true;
    assert.equal(error, undefined);
  }
  assert.equal(threw, true);
  assert.equal(drops, 2);
  a[Symbol.dispose]();
  b[Symbol.dispose]();
  r.close();
  assert.equal(drops, 2);
});
