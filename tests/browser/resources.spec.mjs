import { test, expect } from "./fixtures.mjs";

test("concurrent resource borrows cancel independently and ignore late completion", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createHost } = await import("/guest/index.js");
    const entered = Promise.withResolvers(),
      waits = [];
    const host = createHost({
      bindings: {
        notify() {},
        tick({ signal }) {
          const io = Promise.withResolvers();
          waits.push({ ...io, signal });
          if (waits.length === 2) entered.resolve();
          return io.promise;
        },
      },
    });
    host.attach(
      (
        await WebAssembly.instantiateStreaming(
          fetch("/guest/app.wasm"),
          host.imports,
        )
      ).instance.exports,
    );
    const value = await host.api.counter(7),
      c = new AbortController(),
      reason = { cancelled: true };
    const a = value.wait({ signal: c.signal }).then(
      () => false,
      (e) => e === reason,
    );
    const b = host.api.hold(value);
    await entered.promise;
    const updated = await value.add(1);
    c.abort(reason);
    const cancelled = await a;
    let borrowed = false;
    try {
      value[Symbol.dispose]();
    } catch (e) {
      borrowed = e.code === "RS02";
    }
    const signals = waits.map((w) => w.signal.aborted);
    waits[0].resolve(0); // A late completion must not release B's borrow.
    await new Promise((resolve) => setTimeout(resolve, 0));
    waits[1].resolve(0);
    const resumed = await b;
    value[Symbol.dispose]();
    const drops = await host.api.drops(),
      alive = !host.stats().dead;
    const next = await host.api.counter(10),
      reused = await host.api.consume(next);
    next[Symbol.dispose]();
    const totalDrops = await host.api.drops();
    host.dispose();
    return {
      updated,
      cancelled,
      borrowed,
      signals,
      resumed,
      drops,
      alive,
      reused,
      totalDrops,
      stats: host.stats(),
    };
  });
  expect({ ...result, stats: undefined }).toEqual({
    updated: 8,
    cancelled: true,
    borrowed: true,
    signals: [true, false],
    resumed: 8,
    drops: 1,
    alive: true,
    reused: 10,
    totalDrops: 2,
    stats: undefined,
  });
  expect(
    result.stats.live_values +
      result.stats.live_tasks +
      result.stats.live_waits,
  ).toBe(0);
});

test("a foreign resource poisons only its receiving instance", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createHost } = await import("/guest/index.js");
    const module = await WebAssembly.compileStreaming(fetch("/guest/app.wasm"));
    const connect = async () => {
      const h = createHost({ bindings: { notify() {}, tick: async () => 0 } });
      h.attach((await WebAssembly.instantiate(module, h.imports)).exports);
      return h;
    };
    const a = await connect(),
      b = await connect(),
      value = await a.api.counter(7);
    let code;
    try {
      await b.api.consume(value);
    } catch (e) {
      code = e.code;
    }
    const valueAfter = await value.read(),
      beforeDrops = await a.api.drops();
    value[Symbol.dispose]();
    value[Symbol.dispose]();
    const afterDrops = await a.api.drops(),
      receiverDead = b.stats().dead,
      ownerAlive = !a.stats().dead;
    a.dispose();
    b.dispose();
    return {
      code,
      valueAfter,
      beforeDrops,
      afterDrops,
      receiverDead,
      ownerAlive,
      roots: [a.stats().live_values, b.stats().live_values],
    };
  });
  expect(result).toEqual({
    code: "RS01",
    valueAfter: 7,
    beforeDrops: 0,
    afterDrops: 1,
    receiverDead: true,
    ownerAlive: true,
    roots: [0, 0],
  });
});

test("a Wasm trap rejects pending borrows and never reenters Rust destructors", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createHost } = await import("/guest/index.js");
    const entered = Promise.withResolvers(),
      io = Promise.withResolvers(),
      notifications = [];
    const host = createHost({
      bindings: {
        notify: (phase) => notifications.push(phase),
        tick() {
          entered.resolve();
          return io.promise;
        },
      },
    });
    host.attach(
      (
        await WebAssembly.instantiateStreaming(
          fetch("/guest/app.wasm"),
          host.imports,
        )
      ).instance.exports,
    );
    const value = await host.api.counter(1),
      other = await host.api.counter(2);
    const pending = value.wait().then(
      () => undefined,
      (e) => e,
    );
    await entered.promise;
    let trap;
    try {
      await value.crash();
    } catch (e) {
      trap = e;
    }
    const same = (await pending) === trap;
    value[Symbol.dispose]();
    other[Symbol.dispose]();
    host.dispose();
    io.resolve(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let repeat = false;
    try {
      await value.read();
    } catch (e) {
      repeat = e === trap;
    }
    return {
      trap: trap instanceof WebAssembly.RuntimeError,
      same,
      repeat,
      notifications,
      stats: host.stats(),
    };
  });
  expect(result.trap).toBe(true);
  expect(result.same).toBe(true);
  expect(result.repeat).toBe(true);
  expect(result.notifications).toEqual([]);
  expect(result.stats.dead).toBe(true);
  expect(
    result.stats.live_values +
      result.stats.live_tasks +
      result.stats.live_waits,
  ).toBe(0);
});

test("resource methods can await reentry through an async host callback", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createHost } = await import("/guest/index.js");
    let value;
    const host = createHost({
      bindings: { notify() {}, tick: () => value.add(1) },
    });
    host.attach(
      (
        await WebAssembly.instantiateStreaming(
          fetch("/guest/app.wasm"),
          host.imports,
        )
      ).instance.exports,
    );
    value = await host.api.counter(7);
    const nested = await value.wait(),
      read = await value.read();
    value[Symbol.dispose]();
    const drops = await host.api.drops();
    host.dispose();
    return { nested, read, drops, roots: host.stats().live_values };
  });
  expect(result).toEqual({ nested: 8, read: 8, drops: 1, roots: 0 });
});

test("synchronous resources work without Rust task exports or host bindings", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createHost } = await import("/sync/index.js");
    const module = await WebAssembly.compileStreaming(fetch("/sync/app.wasm"));
    const taskExports = WebAssembly.Module.exports(module).filter((e) =>
      e.name.startsWith("rt_"),
    );
    const host = createHost();
    host.attach((await WebAssembly.instantiate(module, host.imports)).exports);
    const a = await host.api.counter(7),
      b = await host.api.counter(20);
    const updated = await a.add(2),
      independent = await b.read();
    a[Symbol.dispose]();
    a[Symbol.dispose]();
    const moved = await host.api.consume(b);
    b[Symbol.dispose]();
    host.dispose();
    return {
      taskExports,
      updated,
      independent,
      moved,
      roots: host.stats().live_values,
    };
  });
  expect(result).toEqual({
    taskExports: [],
    updated: 9,
    independent: 20,
    moved: 20,
    roots: 0,
  });
});
