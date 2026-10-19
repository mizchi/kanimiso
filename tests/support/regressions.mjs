import { withTestApi } from "./core-host.mjs";
import assert from "node:assert/strict";
import { add } from "./io.mjs";

const flush = async (condition) => {
  for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve();
  assert.ok(condition(), "runtime did not reach expected state");
};
const clean = (host) => {
  const s = host.stats();
  assert.equal(s.live_values, 0);
  assert.equal(s.live_tasks, 0);
  assert.equal(s.live_waits, 0);
  assert.equal(s.dead, false);
  const table = host.imports.jsrt.__values;
  for (let i = 0; i < table.length; i++) assert.ok(table.get(i) == null);
};
// All cases use an actual Wasm instance, including stale pointer/ID paths.
export async function verifyLocal(bytes, glue) {
  let cases = 0;
  const make = async (options = {}) => {
    let events = [],
      onEvent = () => {},
      pointers = [];
    const host = withTestApi(
        glue.createHost({ bindings: { add }, ...options }),
      ),
      f = host.imports.jsrt;
    f.probe_event = (event) => {
      events.push(event);
      onEvent(event);
    };
    const start = f.task_start;
    f.task_start = (key, pointer) => {
      pointers.push(pointer);
      start(key, pointer);
    };
    const { instance } = await WebAssembly.instantiate(bytes, host.imports);
    const raw = instance.exports;
    host.attach(raw);
    const e = new Proxy(
      {},
      {
        get: (_, name) =>
          typeof raw[name] === "function"
            ? (...args) => host.call(name, ...args)
            : raw[name],
      },
    );
    return {
      host,
      e,
      events,
      pointers,
      onEvent(fn) {
        onEvent = fn;
      },
    };
  };
  {
    const { host, e, events, pointers } = await make();
    assert.equal(await e["self-wake"](3), 42);
    assert.equal(events.filter((x) => x === 0).length, 4);
    assert.equal(events.filter((x) => x === 1).length, 1);
    assert.equal(host.stats().polls, 4, "duplicate self-wakes coalesce");
    const oldKey = host.stats().issued_ids;
    // Identical Future layout forces the same allocator class; its address is reused.
    const next = e["self-wake"](0x80000001);
    assert.equal(
      pointers[0],
      pointers[1],
      "fixture must reuse a freed Task pointer",
    );
    const before = host.stats().wakes;
    e.late_wake();
    host.imports.jsrt.task_wake(oldKey);
    assert.equal(
      host.stats().wakes,
      before,
      "old Waker cannot wake the new task",
    );
    assert.equal(await next, 42);
    e.forget_waker();
    clean(host);
    cases++;
  }
  {
    const { host, e, events } = await make();
    let key;
    const pending = e["self-wake"](100),
      rejected = assert.rejects(pending, { name: "AbortError" });
    [key] = host.activeTasks();
    // A task cancelled before its first poll still drops its Future once.
    host.cancel(key);
    await rejected;
    assert.equal(events.filter((x) => x === 1).length, 1);
    assert.equal(events.filter((x) => x === 0).length, 0);
    e.late_wake();
    clean(host);
    cases++;
  }
  {
    const x = await make();
    const { host, e, events } = x;
    const task = e["self-wake"](100),
      rejected = assert.rejects(task, { name: "AbortError" });
    const [key] = host.activeTasks();
    x.onEvent((event) => {
      if (event === 0) {
        assert.equal(events.filter((x) => x === 1).length, 0);
        assert.equal(host.cancel(key), true);
        assert.equal(
          events.filter((x) => x === 1).length,
          0,
          "drop waits until poll returns",
        );
      }
    });
    await rejected;
    assert.equal(events.filter((x) => x === 1).length, 1);
    const polls = host.stats().polls;
    e.late_wake();
    await Promise.resolve();
    assert.equal(host.stats().polls, polls);
    e.forget_waker();
    clean(host);
    cases++;
  }
  {
    const x = await make(),
      { host, e, events } = x;
    const first = e["self-wake"](0),
      second = e["self-wake"](0x80000000);
    const rejected = assert.rejects(second, { name: "AbortError" });
    const [, other] = host.activeTasks();
    x.onEvent((event) => {
      if (event === 0) host.cancel(other);
    });
    assert.equal(await first, 42);
    await rejected;
    assert.equal(
      host.stats().polls,
      1,
      "queued cancelled task is never polled",
    );
    assert.equal(events.filter((x) => x === 1).length, 2);
    e.forget_waker();
    clean(host);
    cases++;
  }
  for (const rejectedValue of [false, true]) {
    const { host, e } = await make();
    let finish;
    const input = new Promise((resolve, reject) => {
      finish = rejectedValue ? reject : resolve;
    });
    const task = e["await-value"](input),
      cancelled = assert.rejects(task, { name: "AbortError" });
    await flush(() => host.stats().live_waits === 1);
    const [old] = host.activeTasks();
    assert.equal(host.cancel(old), true);
    await cancelled;
    const newTask = e["spawn-empty"]();
    finish({ obsolete: true });
    assert.equal(await newTask, undefined);
    await Promise.resolve();
    clean(host);
    cases++;
  }
  {
    const { host, e } = await make({ tokens: { first: 0xfffffffd } });
    assert.equal(
      await e.start(3, 4),
      8,
      "all three IDs pass through signed Wasm i32",
    );
    await assert.rejects(e["await-value"](Promise.resolve(1)), RangeError);
    clean(host);
    cases++;
  }
  {
    const { host, e } = await make({ tokens: { first: 0xffffffff } });
    await assert.rejects(
      e["await-value"](Promise.reject("consumed even on exhaustion")),
      RangeError,
    );
    await assert.rejects(e["spawn-empty"](), RangeError);
    clean(host);
    cases++;
  }
  {
    let request = 0;
    const { host, e } = await make({
      tokens: { first: 1, last: 2 },
      bindings: {
        add: (a, b) => {
          request++;
          return Promise.resolve((a + b) | 0);
        },
      },
    });
    await assert.rejects(e.start(1, 2), RangeError);
    assert.equal(
      request,
      2,
      "second await fails closed when subscribe exhausts",
    );
    clean(host);
    cases++;
  }
  {
    let value;
    const { host, e } = await make({
      bindings: { add: () => Promise.resolve(value) },
    });
    for (value of [
      NaN,
      Infinity,
      -Infinity,
      1.5,
      2147483648,
      -2147483649,
      undefined,
      null,
      "1",
      1n,
      {},
      Symbol("invalid"),
    ]) {
      await assert.rejects(e.start(0, 0), (x) => x === -2);
      cases++;
    }
    clean(host);
  }
  {
    const { host, e } = await make({
      bindings: {
        add: () => {
          throw Error("host trap");
        },
      },
    });
    await assert.rejects(e.start(1, 2), /host trap/);
    const s = host.stats();
    assert.equal(s.dead, true);
    assert.equal(s.live_values + s.live_tasks + s.live_waits, 0);
    assert.throws(() => e.start(1, 2), /host trap/);
    cases++;
  }
  return { all_passed: true, cases };
}
