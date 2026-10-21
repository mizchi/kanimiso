import assert from "node:assert/strict";
import test from "node:test";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
for (const variant of ["canonical", "abort-canonical"]) {
  const abort = variant.startsWith("abort");
  test(`${variant}: dispose drops live tasks before clearing roots and ignores late results`, async () => {
    const { createHost } = await import(`../dist/${variant}.mjs`);
    let signal,
      finish,
      host,
      drops = 0;
    host = createHost({
      bindings: {
        wait: (context) => {
          signal = context?.signal;
          return new Promise((r) => (finish = r));
        },
      },
    });
    const rt = host.imports.jsrt;
    const state = new Map();
    let ptr = 0;
    host.attach({
      run() {
        let id = rt.task_new();
        state.set(++ptr, { id });
        rt.task_start(id, ptr);
        return rt.task_promise(id);
      },
      rt_poll(p) {
        const t = state.get(p);
        t.root = rt.__root({ live: true });
        t.wait = rt.subscribe(host.imports.app.wait(), p);
        return 0;
      },
      rt_drop(p) {
        const t = state.get(p);
        assert.equal(host.stats().live_values > 0, true);
        rt.unsubscribe(t.wait);
        rt.release(t.root);
        state.delete(p);
        drops++;
      },
      rt_settle() {
        assert.fail("late settlement reached freed memory");
      },
    });
    const pending = abort ? host.call("run", undefined) : host.call("run");
    const rejected = assert.rejects(pending, (e) => e.code === "RT13");
    await flush();
    assert.equal(host.stats().live_waits, 1);
    host.dispose();
    host.dispose();
    await rejected;
    assert.equal(drops, 1);
    assert.equal(host.stats().dead, true);
    assert.equal(host.stats().live_values, 0);
    assert.equal(host.stats().live_tasks, 0);
    assert.equal(host.stats().live_waits, 0);
    if (abort) assert.equal(signal.aborted, true);
    finish(42);
    await flush();
    assert.equal(drops, 1);
    assert.throws(
      () => host.call("run"),
      (e) => e.code === "RT13",
    );
  });
  test(`${variant}: disposal during poll defers Drop and rejects new calls`, async () => {
    const { createHost } = await import(`../dist/${variant}.mjs`);
    let dropped = false,
      inPoll = false;
    const host = createHost();
    const rt = host.imports.jsrt;
    host.attach({
      run() {
        const id = rt.task_new();
        rt.task_start(id, 1);
        return rt.task_promise(id);
      },
      rt_poll() {
        inPoll = true;
        host.dispose();
        assert.equal(dropped, false);
        assert.throws(
          () => host.call("run"),
          (e) => e.code === "RT13",
        );
        inPoll = false;
        return 0;
      },
      rt_drop() {
        assert.equal(inPoll, false);
        dropped = true;
      },
    });
    const p = abort ? host.call("run", undefined) : host.call("run");
    await assert.rejects(p, (e) => e.code === "RT13");
    await flush();
    assert.equal(dropped, true);
    assert.equal(host.stats().dead, true);
  });
  test(`${variant}: disposal inside completed task Drop never drops the same frame twice`, async () => {
    const { createHost } = await import(`../dist/${variant}.mjs`);
    const host = createHost(),
      rt = host.imports.jsrt;
    let key,
      drops = 0;
    host.attach({
      run() {
        key = rt.task_new();
        rt.task_start(key, 1);
        return rt.task_promise(key);
      },
      rt_poll() {
        rt.task_finish(key, rt.__root(42), 0);
        return 1;
      },
      rt_drop() {
        drops++;
        if (drops === 1) host.dispose();
      },
    });
    const p = abort ? host.call("run", undefined) : host.call("run");
    await assert.rejects(p, (e) => e.code === "RT13");
    await flush();
    assert.equal(drops, 1);
    assert.equal(host.stats().dead, true);
    assert.equal(host.stats().live_values, 0);
  });
  test(`${variant}: dispose before attach is idempotent; Drop traps preserve first fatal identity`, async () => {
    const { createHost } = await import(`../dist/${variant}.mjs`);
    const empty = createHost();
    empty.dispose();
    empty.dispose();
    assert.throws(
      () => empty.attach({}),
      (e) => e.code === "RT12",
    );
    const host = createHost(),
      rt = host.imports.jsrt,
      error = { dropFailed: true };
    host.attach({
      run() {
        const id = rt.task_new();
        rt.task_start(id, 1);
        return rt.task_promise(id);
      },
      rt_poll() {
        return 0;
      },
      rt_drop() {
        throw error;
      },
    });
    const p = abort ? host.call("run", undefined) : host.call("run");
    const rejected = assert.rejects(p, (e) => e.code === "RT13");
    await flush();
    assert.throws(
      () => host.dispose(),
      (e) => e === error,
    );
    await rejected;
    assert.throws(
      () => host.call("run"),
      (e) => e === error,
    );
    host.dispose();
  });
}
test("JSPI: disposal rejects a suspended call and all queued calls before I/O settles", async () => {
  const { createHost } = await import("../dist/jspi.mjs");
  // Actual Wasm uses JSPI in the browser/consumer integration tests; this
  // factory test substitutes promising to control the suspended entry exactly.
  const old = WebAssembly.promising;
  WebAssembly.promising = (fn) => fn;
  try {
    let finish,
      entered = 0;
    const host = createHost({}, ["run"]);
    host.attach({
      run: () => {
        entered++;
        return new Promise((r) => (finish = r));
      },
    });
    const first = host.call("run"),
      second = host.call("run");
    const a = assert.rejects(first, (e) => e.code === "RT13"),
      b = assert.rejects(second, (e) => e.code === "RT13");
    await flush();
    host.dispose();
    host.dispose();
    await a;
    await b;
    assert.equal(entered, 1);
    assert.equal(host.stats().dead, true);
    finish(42);
    await flush();
    assert.equal(entered, 1);
    assert.equal(host.stats().queued, 0);
  } finally {
    WebAssembly.promising = old;
  }
});
