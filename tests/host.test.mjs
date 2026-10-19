import assert from "node:assert/strict";
import test from "node:test";
import { createHost as runtimeHost } from "../dist/canonical.mjs";
import { withTestApi } from "./support/core-host.mjs";
const createHost = (...args) => withTestApi(runtimeHost(...args));
const task = (host) => {
  const f = host.imports.jsrt,
    id = f.task_new(),
    promise = f.task_promise(id);
  f.task_start(id, 16);
  return { id, promise };
};
test("Drop exception on external cancellation closes the instance and rejects every other task", async () => {
  const failure = Error("drop trap"),
    h = createHost();
  let drops = 0;
  h.attach({
    rt_drop() {
      drops++;
      throw failure;
    },
    rt_poll() {
      return 0;
    },
  });
  const a = task(h),
    b = task(h);
  const cancelled = assert.rejects(a.promise, { name: "AbortError" }),
    failed = assert.rejects(b.promise, (e) => e === failure);
  assert.throws(
    () => h.cancel(a.id),
    (e) => e === failure,
  );
  assert.equal(h.stats().dead, true);
  await Promise.all([cancelled, failed]);
  assert.equal(
    h.stats().live_tasks + h.stats().live_waits + h.stats().live_values,
    0,
  );
  assert.equal(h.cancel(b.id), false);
  await Promise.resolve();
  assert.equal(drops, 1);
});
test("successful output is committed only after Drop succeeds", async () => {
  const failure = Error("completion drop trap"),
    h = createHost();
  h.attach({
    rt_poll() {
      h.imports.jsrt.task_finish(1, { value: 42 }, 0);
      return 1;
    },
    rt_drop() {
      throw failure;
    },
  });
  const a = task(h);
  await assert.rejects(a.promise, (e) => e === failure);
  assert.equal(h.stats().dead, true);
});
test("managed export traps preserve the original fatal error and forbid later calls", async () => {
  const failure = Error("entry trap"),
    h = createHost();
  let calls = 0;
  h.attach({
    start() {
      calls++;
      throw failure;
    },
    rt_poll() {
      return 0;
    },
    rt_drop() {},
  });
  const a = task(h),
    rejected = assert.rejects(a.promise, (e) => e === failure);
  await assert.rejects(h.promise("start"), (e) => e === failure);
  await rejected;
  await assert.rejects(h.promise("start"), (e) => e === failure);
  assert.equal(calls, 1);
});
test("managed exports cannot resume after a nested fatal error is caught by JS", () => {
  const failure = Error("nested drop trap"),
    h = createHost();
  h.attach({
    start() {
      try {
        h.cancel(1);
      } catch {}
      return 42;
    },
    rt_drop() {
      throw failure;
    },
    rt_poll() {
      return 0;
    },
  });
  const a = task(h);
  a.promise.catch(() => {});
  assert.throws(
    () => h.call("start"),
    (e) => e === failure,
  );
  assert.equal(h.stats().dead, true);
});
test("configured root limit fails closed with a typed OOM error", () => {
  const h = createHost({ maxValues: 1 });
  h.attach({});
  h.imports.jsrt.__root({});
  assert.throws(
    () => h.imports.jsrt.__root({}),
    (e) => e.name === "WasmOutOfMemoryError" && e.code === "ERR_WASM_OOM",
  );
  assert.equal(h.stats().dead, true);
  assert.equal(h.stats().live_values, 0);
});
