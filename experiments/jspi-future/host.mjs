import { Gates } from "./gates.mjs";

// Experimental only. Sync bookkeeping imports NEVER suspend or enter the guest.
// Only park suspends, after Rust Future::poll has returned Pending.
export async function instantiate(
  source,
  { bindings: { add } } = { bindings: {} },
) {
  if (
    typeof WebAssembly.promising !== "function" ||
    typeof WebAssembly.Suspending !== "function"
  )
    throw Error("JSPI required");
  if (typeof add !== "function") throw TypeError("add binding required");
  const gates = new Gates(),
    completed = new Map(),
    jobs = new Map(),
    functions = Object.create(null);
  let next = 0,
    dead = false,
    fatal,
    queued = 0,
    polls = 0,
    drops = 0;
  const alive = () => {
    if (dead) throw fatal;
  };
  const poison = (error) => {
    if (!dead) {
      dead = true;
      fatal = error;
      gates.retire(error);
      jobs.clear();
      completed.clear();
      for (const name in functions) delete functions[name];
    }
    return fatal;
  };
  const sync =
    (fn) =>
    (...args) => {
      alive();
      try {
        return fn(...args);
      } catch (e) {
        throw poison(e);
      }
    };
  const imports = {
    open: sync(() => {
      const id = gates.open();
      completed.set(id, []);
      return id;
    }),
    signal: sync((id) => gates.signal(id)),
    close: sync((id) => {
      completed.delete(id);
      gates.close(id);
    }),
    drain: sync((id) => {
      const queue = completed.get(id);
      if (!queue) throw Error("unknown gate");
      return queue.shift() ?? 0;
    }),
    park: new WebAssembly.Suspending(async (id) => {
      alive();
      try {
        await gates.park(id);
        alive();
      } catch (e) {
        throw poison(e);
      }
    }),
    begin: sync((gate, a, b) => {
      if (next === 0x7fffffff) throw Error("job IDs exhausted");
      const id = ++next,
        job = { gate, ready: false, value: 0 };
      jobs.set(id, job);
      Promise.resolve(add(a, b)).then(
        (value) => {
          if (dead || jobs.get(id) !== job) return;
          job.value = value;
          job.ready = true;
          completed.get(gate).push(id);
          gates.signal(gate);
        },
        (error) => {
          if (!dead && jobs.get(id) === job) poison(error);
        },
      );
      return id;
    }),
    ready: sync((id) => {
      polls++;
      const job = jobs.get(id);
      if (!job) throw Error("unknown job");
      return +job.ready;
    }),
    take: sync((id) => {
      const job = jobs.get(id);
      if (!job?.ready) throw Error("job pending");
      jobs.delete(id);
      return job.value;
    }),
    cancel: sync((id) => jobs.delete(id)),
    dropped: sync(() => {
      drops++;
    }),
  };
  const loaded = await WebAssembly.instantiate(source, { app: imports });
  const instance =
    loaded instanceof WebAssembly.Instance ? loaded : loaded.instance;
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    instance.exports.memory?.buffer instanceof SharedArrayBuffer
  )
    throw Error("shared memory unsupported");
  for (const [name, value] of Object.entries(instance.exports))
    if (
      typeof value === "function" &&
      !name.startsWith("rt_") &&
      !name.startsWith("cabi_")
    )
      functions[name] = WebAssembly.promising(value);
  let tail = Promise.resolve();
  const call = (name, ...args) => {
    queued++;
    const result = tail
      .then(async () => {
        alive();
        if (typeof functions[name] !== "function")
          throw Error("unknown export");
        try {
          const value = await functions[name](...args);
          alive();
          return value;
        } catch (e) {
          throw poison(e);
        }
      })
      .finally(() => queued--);
    tail = result.catch(() => {});
    return result;
  };
  return {
    call,
    promise: call,
    stats: () => ({
      ...gates.stats(),
      jobs: jobs.size,
      completion_queues: completed.size,
      queued,
      polls,
      drops,
      dead,
    }),
  };
}
