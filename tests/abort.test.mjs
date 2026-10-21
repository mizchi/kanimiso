import assert from "node:assert/strict";
import test from "node:test";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function fixture(binding, onSettle = () => {}) {
  const { createHost } = await import("../dist/abort-canonical.mjs");
  const host = createHost({ bindings: { wait: binding } });
  const tasks = new Map();
  let serial = 0,
    drops = 0;
  host.attach({
    run(value) {
      const id = host.imports.jsrt.task_new();
      tasks.set(++serial, { id, value });
      host.imports.jsrt.task_start(id, serial);
      return host.imports.jsrt.task_promise(id);
    },
    rt_poll(ptr) {
      const t = tasks.get(ptr);
      if (!t.started) {
        t.started = true;
        const promise = host.imports.app.wait(t.value);
        t.wait = host.imports.jsrt.subscribe(promise, ptr);
        return 0;
      }
      host.imports.jsrt.task_finish(t.id, t.result, 0);
      return 1;
    },
    rt_settle(ptr, result) {
      onSettle();
      const t = tasks.get(ptr);
      t.result = result;
      host.imports.jsrt.task_wake(t.id);
    },
    rt_drop(ptr) {
      const t = tasks.get(ptr);
      host.imports.jsrt.unsubscribe(t.wait);
      tasks.delete(ptr);
      drops++;
    },
    trap() {
      throw new Error("external trap");
    },
  });
  return { host, drops: () => drops };
}

test("AbortSignal isolates concurrent calls and forwards the reason to host I/O", async () => {
  const seen = new Map(),
    completion = new Map();
  const { host, drops } = await fixture((value, { signal }) => {
    seen.set(value, signal);
    return new Promise((resolve, reject) => {
      completion.set(value, resolve);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const a = new AbortController(),
    b = new AbortController(),
    reason = { cancelled: 1 };
  const first = host.call("run", a.signal, 1),
    second = host.call("run", b.signal, 2);
  const rejection = assert.rejects(first, (e) => e === reason);
  await flush();
  a.abort(reason);
  await rejection;
  assert.equal(seen.get(1).reason, reason);
  assert.equal(seen.get(2).aborted, false);
  completion.get(1)(100);
  completion.get(2)(42);
  assert.equal(await second, 42);
  await flush();
  assert.equal(drops(), 2);
  assert.equal(host.stats().live_tasks, 0);
  assert.equal(host.stats().live_waits, 0);
  assert.equal(
    await (async () => {
      const p = host.call("run", undefined, 3);
      await flush();
      completion.get(3)(3);
      return p;
    })(),
    3,
  );
});

test("pre-abort does not enter Wasm; abort during poll defers Drop until poll returns", async () => {
  const controller = new AbortController(),
    reason = new Error("stop");
  controller.abort(reason);
  const { host, drops } = await fixture(() => {
    throw Error("must not execute");
  });
  await assert.rejects(
    host.call("run", controller.signal, 1),
    (e) => e === reason,
  );
  assert.equal(host.stats().issued_ids, 0);
  const live = new AbortController();
  const f = await fixture((_, { signal }) => {
    live.abort(reason);
    assert.equal(f.drops(), 0);
    assert.equal(signal.reason, reason);
    return Promise.resolve(1);
  });
  await assert.rejects(f.host.call("run", live.signal, 1), (e) => e === reason);
  await flush();
  assert.equal(f.drops(), 1);
  assert.equal(f.host.stats().live_waits, 0);
  assert.equal(f.host.stats().dead, false);
  assert.equal(drops(), 0);
});

test("signal listeners retire on success and host traps abort pending I/O", async () => {
  let added = 0,
    removed = 0;
  const c = new AbortController(),
    add = c.signal.addEventListener.bind(c.signal),
    remove = c.signal.removeEventListener.bind(c.signal);
  c.signal.addEventListener = (...args) => {
    added++;
    return add(...args);
  };
  c.signal.removeEventListener = (...args) => {
    removed++;
    return remove(...args);
  };
  let signal;
  const { host } = await fixture((v, context) => {
    signal = context.signal;
    return v === 1 ? Promise.resolve(v) : new Promise(() => {});
  });
  assert.equal(await host.call("run", c.signal, 1), 1);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  const pending = host.call("run", undefined, 2);
  const rejected = assert.rejects(pending, /external trap/);
  await flush();
  assert.throws(() => host.call("trap", undefined), /external trap/);
  await rejected;
  assert.equal(signal.aborted, true);
});

test("tasks spawned after a synchronous abort inherit the cancelled scope", async () => {
  const reason = { stop: true };
  let child;
  let childDropped = 0;
  // A fresh minimal host exercises late start without relying on fake fixture state.
  const { createHost } = await import("../dist/abort-canonical.mjs");
  let id;
  const late = createHost();
  const c = new AbortController();
  late.attach({
    run() {
      id = late.imports.jsrt.task_new();
      late.imports.jsrt.task_start(id, 1);
      return late.imports.jsrt.task_promise(id);
    },
    rt_poll() {
      c.abort(reason);
      const k = late.imports.jsrt.task_new();
      child = k;
      late.imports.jsrt.task_promise(k).catch(() => {});
      late.imports.jsrt.task_start(k, 2);
      return 0;
    },
    rt_drop() {
      childDropped++;
    },
  });
  await assert.rejects(late.call("run", c.signal), (e) => e === reason);
  await flush();
  assert.equal(childDropped, 2);
  assert.equal(late.cancel(child), false);
  assert.equal(late.stats().live_tasks, 0);
});

test("a reentrant exported call has its own signal scope and preserves null reasons", async () => {
  const a = new AbortController(),
    b = new AbortController(),
    seen = new Map(),
    complete = new Map();
  let second;
  const { host } = await fixture((value, { signal }) => {
    seen.set(value, signal);
    if (value === 1) second = host.call("run", b.signal, 2);
    return new Promise((resolve) => complete.set(value, resolve));
  });
  const first = host.call("run", a.signal, 1),
    rejected = assert.rejects(first, (e) => e === null);
  await flush();
  a.abort(null);
  await rejected;
  assert.equal(
    seen.get(2).aborted,
    false,
    "nested JS entry must not inherit the currently polled call",
  );
  complete.get(2)(42);
  assert.equal(await second, 42);
  await flush();
  assert.equal(host.stats().live_tasks, 0);
});

test("callbacks reached through an external Waker keep the subscription's scope", async () => {
  const seen = [];
  const { host } = await fixture(
    (value, context) => {
      seen.push(context);
      return Promise.resolve(value);
    },
    () => host.imports.app.wait(2),
  );
  assert.equal(await host.call("run", undefined, 1), 1);
  assert.ok(seen[0]?.signal);
  assert.equal(seen[1], seen[0]);
});
