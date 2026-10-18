const check = (ok, message) => {
  if (!ok) throw Error(message);
};
const tick = async (condition) => {
  for (let i = 0; i < 200 && !condition(); i++) await Promise.resolve();
  check(condition(), "driver did not progress");
};
export async function verifyDriver(instantiate, bytes) {
  let host = await instantiate(bytes, {
    bindings: { add: async (a, b) => (a + b) | 0 },
  });
  for (const count of [0, 1, 64, 1024])
    check((await host.call("self-wake", count)) === count, "self wake lost");
  check(host.stats().parks === 1089, "unexpected self-wake polls");
  check(host.stats().gates === 0, "self-wake gate leak");

  const pending = [];
  host = await instantiate(bytes, {
    bindings: {
      add: (a, b) => new Promise((resolve) => pending.push({ a, b, resolve })),
    },
  });
  let done = false;
  const joined = host.call("joined", 10, 20).then((v) => {
    done = true;
    return v;
  });
  await tick(() => pending.length === 2);
  check(!done, "join did not suspend");
  const before = host.stats().polls;
  pending[1].resolve(22);
  await tick(() => host.stats().polls > before);
  check(!done, "join completed before both I/O");
  pending[0].resolve(11);
  check((await joined) === 33, "join result");
  check(host.stats().jobs === 0 && host.stats().gates === 0, "join leaked");

  pending.length = 0;
  const unordered = host.call("unordered", 10, 20);
  await tick(() => pending.length === 2);
  const polled = host.stats().polls;
  pending[1].resolve(22);
  await tick(() => host.stats().polls > polled);
  pending[0].resolve(11);
  check(
    (await unordered) === 33,
    "FuturesUnordered child Waker did not progress",
  );
  check(
    host.stats().jobs === 0 && host.stats().gates === 0,
    "unordered leaked",
  );

  pending.length = 0;
  const raced = host.call("raced", 30, 40);
  await tick(() => pending.length === 2);
  const loser = pending[0];
  pending[1].resolve(42);
  check((await raced) === 42, "select winner");
  check(
    host.stats().jobs === 0 && host.stats().gates === 0,
    "loser Future::drop did not release job",
  );
  // Deliver the old completion while a new invocation is suspended. Never reuse IDs.
  pending.length = 0;
  const after = host.call("held", 50, 1);
  await tick(() => pending.length === 1);
  const parks = host.stats().parks;
  loser.resolve(31);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  check(host.stats().parks === parks, "stale completion woke a different task");
  check(!host.stats().dead, "stale completion poisoned host");
  pending[0].resolve(51);
  check((await after) === 101, "late-completion followup");
  check(host.stats().drops === 1, "normal Rust Drop skipped");

  let active = 0,
    peak = 0;
  pending.length = 0;
  host = await instantiate(bytes, {
    bindings: {
      add: (a, b) => {
        peak = Math.max(peak, ++active);
        return new Promise((resolve) =>
          pending.push(() => {
            active--;
            resolve((a + b) | 0);
          }),
        );
      },
    },
  });
  const held = Promise.all(
    Array.from({ length: 32 }, (_, i) => host.call("held", i, 10)),
  );
  for (let i = 0; i < 32; i++) {
    await tick(() => pending.length);
    pending.shift()();
  }
  const values = await held;
  check(
    values.every((v, i) => v === i * 2 + 10),
    "pinned 1 KiB Future stack changed",
  );
  check(
    peak === 1 && host.stats().drops === 32,
    "entry serialization/Drop mismatch",
  );
  check(
    host.stats().jobs === 0 &&
      host.stats().gates === 0 &&
      host.stats().queued === 0,
    "held leaked",
  );

  for (const reason of [undefined, { failed: true }]) {
    let requests = 0;
    const h = await instantiate(bytes, {
      bindings: {
        add: () => {
          requests++;
          return Promise.reject(reason);
        },
      },
    });
    const result = await Promise.all(
      [h.call("held", 7, 9), h.call("held", 1, 2)].map((p) =>
        p.then(
          (value) => ({ value }),
          (error) => ({ rejected: true, error }),
        ),
      ),
    );
    check(
      result.every((r) => r.rejected && r.error === reason),
      "first-fatal rejection changed",
    );
    check(
      h.stats().dead && h.stats().jobs === 0 && h.stats().gates === 0,
      "fatal cleanup incomplete",
    );
    check(
      requests === 1 && h.stats().drops === 0,
      "failed guest reentered or unwound Rust Drop",
    );
  }
  const trapped = await instantiate(bytes, {
    bindings: { add: async (a, b) => (a + b) | 0 },
  });
  let trap;
  try {
    await trapped.call("trap");
  } catch (error) {
    trap = error;
  }
  check(
    trap instanceof WebAssembly.RuntimeError,
    "post-suspension trap missing",
  );
  let later;
  try {
    await trapped.call("held", 1, 2);
  } catch (error) {
    later = error;
  }
  check(later === trap && trapped.stats().dead, "trap first-fatal changed");
  check(
    trapped.stats().gates === 0 &&
      trapped.stats().jobs === 0 &&
      trapped.stats().completion_queues === 0,
    "trap leaked host state",
  );
  return {
    all_passed: true,
    self_wakes: 1089,
    join_reverse_completion: true,
    futures_unordered_child_wakers: true,
    select_drops_loser: true,
    late_completion_isolated: true,
    pinned_stack_tasks: 32,
    pinned_stack_bytes: 1024,
    rejection_reasons: 2,
    post_suspension_trap: true,
  };
}
