import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page, browser, browserName }, info) => {
  info.annotations.push({
    type: "engine",
    description: `${browserName} ${browser.version()}`,
  });
  await page.goto("/");
});
test("Future rich values, memory growth, rejection identity, cancellation and disposal", async ({
  page,
  browserName,
}) => {
  const report = await page.evaluate(async () => {
    const { createHost } = await import("/future/index.js");
    const bytes = await (await fetch("/future/app.wasm")).arrayBuffer();
    let ioSignal;
    const held = new Map(),
      failure = { host: true };
    const host = createHost({
      bindings: {
        exchange(v, { signal }) {
          ioSignal = signal;
          if (v.label === "reject") return Promise.reject(failure);
          if (v.label === "pending")
            return new Promise((resolve) => held.set(v.id, resolve));
          return Promise.resolve(v);
        },
      },
    });
    host.attach(
      (await WebAssembly.instantiate(bytes, host.imports)).instance.exports,
    );
    const packet = {
      id: 18446744073709551615n,
      label: "日本語 🦀\uFEFF\0",
      payload: new Uint8Array([0, 128, 255]),
    };
    const output = await host.run(packet);
    await host.grow(2);
    const copied =
      output.label === packet.label &&
      output.id === packet.id &&
      output.payload.join() === packet.payload.join();
    let identity = false;
    try {
      await host.run({ ...packet, label: "reject" });
    } catch (e) {
      identity = e === failure;
    }
    const c = new AbortController(),
      p = host.run(
        { ...packet, id: 1n, label: "pending" },
        { signal: c.signal },
      );
    p.catch(() => {});
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const signal = ioSignal;
    c.abort(failure);
    let cancelled = false;
    try {
      await p;
    } catch (e) {
      cancelled = e === failure && signal.reason === failure;
    }
    const q = host.run({ ...packet, id: 2n, label: "pending" });
    q.catch(() => {});
    for (let i = 0; i < 50; i++) await Promise.resolve();
    host.dispose();
    let disposed = false;
    try {
      await q;
    } catch (e) {
      disposed = e.code === "RT13";
    }
    held.get(1n)(packet);
    held.get(2n)(packet);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    return {
      copied,
      identity,
      cancelled,
      disposed,
      stats: host.stats(),
      userAgent: navigator.userAgent,
    };
  });
  expect(report.copied).toBe(true);
  expect(report.identity).toBe(true);
  expect(report.cancelled).toBe(true);
  expect(report.disposed).toBe(true);
  expect(report.stats.dead).toBe(true);
  expect(
    report.stats.live_tasks +
      report.stats.live_waits +
      report.stats.live_values,
  ).toBe(0);
  await test.info().attach("engine", {
    body: JSON.stringify({ browserName, ...report }),
    contentType: "application/json",
  });
});
test("JSPI executes real Wasm and disposal rejects suspended and queued requests", async ({
  page,
}) => {
  const report = await page.evaluate(async () => {
    const { createHost } = await import("/jspi/index.js");
    const bytes = await (await fetch("/jspi/app.wasm")).arrayBuffer();
    let blocked = false,
      release;
    const host = createHost({
      bindings: {
        add: async (a, b) =>
          blocked ? new Promise((r) => (release = () => r(a + b))) : a + b,
      },
    });
    host.attach(
      (await WebAssembly.instantiate(bytes, host.imports)).instance.exports,
    );
    const result = await host.run(20, 21);
    blocked = true;
    const a = host.run(1, 2),
      b = host.run(3, 4);
    a.catch(() => {});
    b.catch(() => {});
    for (let i = 0; i < 50; i++) await Promise.resolve();
    host.dispose();
    const errors = await Promise.all(
      [a, b].map((p) =>
        p.then(
          () => "",
          (e) => e.code,
        ),
      ),
    );
    release();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    return { result, errors, dead: host.stats().dead };
  });
  expect(report.result).toBe(42);
  expect(report.errors).toEqual(["RT13", "RT13"]);
  expect(report.dead).toBe(true);
});

test("resource constructors, own/borrow and Symbol.dispose preserve lifetimes across cancellation", async ({
  page,
}) => {
  const report = await page.evaluate(async () => {
    const { createHost } = await import("/future/index.js");
    const bytes = await (await fetch("/future/app.wasm")).arrayBuffer();
    let drops = 0,
      slow = false;
    const host = createHost({
      bindings: {
        exchange: async (v) => v,
        io: {
          value: (text) => ({
            text,
            [Symbol.dispose]() {
              drops++;
            },
          }),
          read: async (v) => (slow ? new Promise(() => {}) : v.text),
        },
      },
    });
    host.attach(
      (await WebAssembly.instantiate(bytes, host.imports)).instance.exports,
    );
    const lease = await host.make(),
      text = await host.inspect(lease);
    slow = true;
    const c = new AbortController(),
      pending = host.inspect(lease, { signal: c.signal });
    pending.catch(() => {});
    for (let i = 0; i < 50; i++) await Promise.resolve();
    let blocked = false;
    try {
      lease[Symbol.dispose]();
    } catch (e) {
      blocked = e.code === "RS02";
    }
    c.abort();
    try {
      await pending;
    } catch {}
    lease[Symbol.dispose]();
    slow = false;
    const own = await host.make();
    await host.consume(own);
    own[Symbol.dispose]();
    host.dispose();
    return {
      text,
      blocked,
      drops,
      symbol: typeof Symbol.dispose === "symbol",
      roots: host.stats().live_values,
    };
  });
  expect(report).toEqual({
    text: "resource 🦀",
    blocked: true,
    drops: 2,
    symbol: true,
    roots: 0,
  });
});

test("AbortSignal cancels a real browser fetch", async ({ page }) => {
  const report = await page.evaluate(async () => {
    const { createHost } = await import("/future/index.js");
    const bytes = await (await fetch("/future/app.wasm")).arrayBuffer();
    let signal;
    const host = createHost({
      bindings: {
        exchange: async (v, context) => {
          signal = context.signal;
          await fetch("/pending", { signal });
          return v;
        },
      },
    });
    host.attach(
      (await WebAssembly.instantiate(bytes, host.imports)).instance.exports,
    );
    const c = new AbortController(),
      p = host.run(
        { id: 1n, label: "fetch", payload: new Uint8Array() },
        { signal: c.signal },
      );
    p.catch(() => {});
    for (let i = 0; i < 50; i++) await Promise.resolve();
    c.abort();
    let rejected = false;
    try {
      await p;
    } catch (e) {
      rejected = e === c.signal.reason;
    }
    host.dispose();
    return {
      rejected,
      aborted: signal.aborted,
      roots: host.stats().live_values,
    };
  });
  expect(report).toEqual({ rejected: true, aborted: true, roots: 0 });
});
