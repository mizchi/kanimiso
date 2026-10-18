const check = (condition, message) => {
  if (!condition) throw Error(message);
};
const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};
const settle = (request) => request.resolve((request.a + request.b) | 0);
const create = async (instantiate, bytes, requests) =>
  instantiate(bytes, {
    bindings: {
      add: (a, b) =>
        new Promise((resolve, reject) =>
          requests.push({ a, b, resolve, reject }),
        ),
    },
  });
const clean = (host) => {
  if (!host.stats) return;
  const s = host.stats();
  check(
    s.roots === 0 && s.snapshot_bytes === 0 && s.pending === 0,
    "parked stack leaked",
  );
};

// Uses real Rust stack arrays; the common run algorithm is verified separately.
async function verifyConcurrentContract(instantiate, bytes) {
  let requests = [];
  let host = await create(instantiate, bytes, requests);
  const a = host.promise("hold", 10, 1),
    b = host.promise("hold", 20, 1);
  await flush();
  check(requests.length === 2, "independent entries did not start");
  settle(requests[0]);
  check((await a) === 21, "first stack corrupted");
  const c = host.promise("overwrite", 30, 1);
  await flush();
  settle(requests[2]);
  check((await c) === 61, "overwrite result");
  settle(requests[1]);
  check((await b) === 41, "non-LIFO victim stack corrupted");
  clean(host);

  requests = [];
  host = await create(instantiate, bytes, requests);
  const preserved = host.promise("hold", 33, 1);
  await flush();
  check(
    (await host.call("counter")) === 1 && (await host.call("counter")) === 2,
    "shared data probe",
  );
  settle(requests[0]);
  check((await preserved) === 67, "global-state stack result");
  check(
    (await host.call("counter")) === 3,
    "stack restore rolled back shared data",
  );
  const other = await instantiate(bytes, {
    bindings: { add: async (a, b) => (a + b) | 0 },
  });
  check(
    (await other.call("counter")) === 1 && (await host.call("counter")) === 4,
    "instances share state",
  );
  clean(host);
  clean(other);

  for (const sameTick of [false, true]) {
    requests = [];
    host = await create(instantiate, bytes, requests);
    const jobs = Array.from({ length: 32 }, (_, i) =>
      host.promise("hold", i, 10),
    );
    await flush();
    check(requests.length === 32, "32 entries did not park");
    // Every completion is delivered; the seed order is deliberately non-LIFO.
    const order = Array.from({ length: 32 }, (_, i) => (i * 13) % 32);
    for (const i of order) {
      settle(requests[i]);
      if (!sameTick) await flush();
    }
    const values = await Promise.all(jobs);
    check(
      values.every((v, i) => v === 2 * i + 10),
      "simultaneous completion corrupted spills",
    );
    clean(host);
  }

  requests = [];
  host = await create(instantiate, bytes, requests);
  const held = host.promise("hold", 40, 1),
    grown = host.promise("grow", 50, 1);
  await flush();
  settle(requests[1]);
  check((await grown) === 101, "memory.grow result");
  settle(requests[0]);
  check((await held) === 81, "detached memory view used");
  clean(host);

  requests = [];
  host = await create(instantiate, bytes, requests);
  const owner = host.promise("borrowed", 60, 1);
  await flush();
  check(
    (await host.promise("borrowed", 70, 1)) === -1,
    "shared borrow was silently isolated",
  );
  check(requests.length === 1, "conflicting shared borrow started I/O");
  settle(requests[0]);
  check((await owner) === 61, "borrow owner corrupted");
  const reused = host.promise("borrowed", 80, 1);
  await flush();
  settle(requests[1]);
  check((await reused) === 81, "borrow guard not dropped");
  clean(host);

  // Reentrant calls from a binding are allowed, with no Rust state borrowed across entries.
  let reentrant;
  reentrant = await instantiate(bytes, {
    bindings: {
      add: async (a, b) =>
        a === 100 ? reentrant.promise("run", 1, 2) : (a + b) | 0,
    },
  });
  check(
    (await reentrant.promise("run", 100, 0)) === 5,
    "same-instance binding reentry stalled",
  );
  clean(reentrant);

  for (const reason of [undefined, { failed: true }]) {
    requests = [];
    host = await create(instantiate, bytes, requests);
    const outcomes = Promise.all(
      [host.promise("hold", 1, 1), host.promise("hold", 2, 1)].map((p) =>
        p.then(
          () => ({ ok: true }),
          (error) => ({ error }),
        ),
      ),
    );
    await flush();
    check(requests.length === 2, "fatal probe did not overlap");
    requests[0].reject(reason);
    // The second I/O is intentionally NEVER settled until both roots reject.
    const result = await outcomes;
    check(
      result.every((r) => !r.ok && r.error === reason),
      "first-fatal identity changed",
    );
    clean(host);
    settle(requests[1]);
    await flush();
    clean(host);
    const next = await host.call("run", 1, 1).then(
      () => ({ ok: true }),
      (error) => ({ error }),
    );
    check(!next.ok && next.error === reason, "closed instance accepted a call");
  }

  requests = [];
  host = await create(instantiate, bytes, requests);
  const trapped = host.promise("trap", 1, 1).catch((error) => error),
    parked = host.promise("hold", 2, 1).catch((error) => error);
  await flush();
  settle(requests[0]);
  const trap = await trapped;
  check(
    trap instanceof WebAssembly.RuntimeError && (await parked) === trap,
    "trap did not retire sibling stacks",
  );
  clean(host);
  settle(requests[1]);
  await flush();
  clean(host);
  return {
    all_passed: true,
    non_lifo: true,
    simultaneous_spills: 32,
    memory_grow: true,
    shared_borrow_conflict: true,
    binding_reentry: true,
    shared_data_preserved: true,
    instance_isolation: true,
    fatal_retires_parked: true,
  };
}

export async function verifyUnsafeControl(raw) {
  const requests = [];
  const { instance } = await WebAssembly.instantiate(raw, {
    app: {
      add: new WebAssembly.Suspending(
        (a, b) => new Promise((resolve) => requests.push({ a, b, resolve })),
      ),
    },
  });
  const hold = WebAssembly.promising(instance.exports.hold),
    overwrite = WebAssembly.promising(instance.exports.overwrite);
  const a = hold(10, 1),
    b = hold(20, 1).then(
      () => ({ ok: true }),
      (error) => ({ error }),
    );
  await flush();
  settle(requests[0]);
  await a;
  const c = overwrite(30, 1);
  await flush();
  settle(requests[2]);
  await c;
  settle(requests[1]);
  check(
    (await b).error instanceof WebAssembly.RuntimeError,
    "unprotected control did not detect stack corruption",
  );
  return { stack_corruption_detected: true };
}

export async function verifyConcurrent(...args) {
  let timer;
  try {
    return await Promise.race([
      verifyConcurrentContract(...args),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("concurrent verification timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyFutureOverlap(instantiate, module) {
  for (const name of ["joined", "unordered", "raced"]) {
    const requests = [];
    const host = await create(instantiate, module, requests);
    const jobs = Array.from({ length: 16 }, (_, i) =>
      host.call(name, i, i + 100),
    );
    await flush();
    check(requests.length === 32, "child futures did not overlap across roots");
    for (let i = 15; i >= 0; i--) settle(requests[i * 2 + 1]);
    await flush();
    for (let i = 0; i < 16; i++) settle(requests[i * 2]);
    const result = await Promise.all(jobs);
    check(
      result.every((v, i) => v === (name === "raced" ? i + 102 : 2 * i + 103)),
      "cross-root child Waker delivered to wrong Future",
    );
    await flush();
    if (host.stats) {
      const s = host.stats();
      check(
        s.stack.roots === 0 &&
          s.stack.snapshot_bytes === 0 &&
          s.jobs === 0 &&
          s.gates === 0,
        "cross-root combinator leaked",
      );
    }
  }
  return { roots: 16, child_io: 32, join: true, unordered: true, select: true };
}
