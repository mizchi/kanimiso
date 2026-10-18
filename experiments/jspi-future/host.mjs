import { createStacks } from "../jspi-concurrent/stack.mjs";
import { Gates } from "./gates.mjs";
import { runtimeError } from "./errors.mjs";

// Experimental only. Sync bookkeeping imports NEVER suspend or enter the guest.
// Only park suspends, after Rust Future::poll has returned Pending.
export async function instantiate(
  source,
  { bindings: { add, dropped = () => {} } } = { bindings: {} },
) {
  if (
    typeof WebAssembly.promising !== "function" ||
    typeof WebAssembly.Suspending !== "function"
  )
    throw runtimeError(3);
  if (typeof add !== "function") throw runtimeError(4, TypeError);
  if (typeof dropped !== "function") throw runtimeError(14, TypeError);
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
  if (__JF_CONCURRENT__) gates.stacks_ = createStacks(alive);
  const poison = (error) => {
    if (!dead) {
      dead = true;
      fatal = error;
      if (__JF_CONCURRENT__) gates.stacks_.close();
      gates.retire_(error);
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
    fail: sync((code) => {
      throw runtimeError(code);
    }),
    open: sync(() => {
      const id = gates.open_();
      completed.set(id, []);
      return id;
    }),
    signal: sync((id) => gates.signal_(id)),
    close: sync((id) => {
      completed.delete(id);
      gates.close_(id);
    }),
    drain: sync((id) => {
      const queue = completed.get(id);
      if (!queue) throw runtimeError(5);
      return queue.shift() ?? 0;
    }),
    park: new WebAssembly.Suspending(async (id) => {
      alive();
      try {
        await gates.park_(id);
        alive();
      } catch (e) {
        throw poison(e);
      }
    }),
    begin: sync((gate, a, b) => {
      if (next === 0x7fffffff) throw runtimeError(6);
      const id = ++next,
        job = { gate_: gate, ready_: false, value_: 0 };
      jobs.set(id, job);
      Promise.resolve(add(a, b)).then(
        (value) => {
          if (dead || jobs.get(id) !== job) return;
          job.value_ = value;
          job.ready_ = true;
          completed.get(gate).push(id);
          gates.signal_(gate);
        },
        (error) => {
          if (!dead && jobs.get(id) === job) poison(error);
        },
      );
      return id;
    }),
    ready: sync((id) => {
      if (__JF_DEBUG__) polls++;
      const job = jobs.get(id);
      if (!job) throw runtimeError(7);
      return +job.ready_;
    }),
    take: sync((id) => {
      const job = jobs.get(id);
      if (!job?.ready_) throw runtimeError(8);
      jobs.delete(id);
      return job.value_;
    }),
    cancel: sync((id) => jobs.delete(id)),
    dropped: __JF_DEBUG__
      ? sync(() => {
          drops++;
          dropped();
        })
      : sync(dropped),
  };
  const loaded = await WebAssembly.instantiate(
    source,
    __JF_CONCURRENT__
      ? { app: imports, "taraba:jspi-stack": gates.stacks_.imports }
      : { app: imports },
  );
  const instance =
    loaded instanceof WebAssembly.Instance ? loaded : loaded.instance;
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    instance.exports.memory?.buffer instanceof SharedArrayBuffer
  )
    throw runtimeError(9);
  if (__JF_CONCURRENT__) gates.stacks_.attach(instance.exports);
  for (const [name, value] of Object.entries(instance.exports))
    if (
      typeof value === "function" &&
      !name.startsWith("rt_") &&
      !name.startsWith("cabi_")
    )
      functions[name] = WebAssembly.promising(value);
  let tail = Promise.resolve();
  const call = (name, ...args) => {
    if (__JF_DEBUG__) queued++;
    let result = (__JF_CONCURRENT__ ? Promise.resolve() : tail).then(
      async () => {
        alive();
        if (typeof functions[name] !== "function") throw runtimeError(10);
        try {
          const value = await functions[name](...args);
          alive();
          return value;
        } catch (e) {
          throw poison(e);
        }
      },
    );
    if (__JF_DEBUG__) result = result.finally(() => queued--);
    if (!__JF_CONCURRENT__) tail = result.catch(() => {});
    return result;
  };
  return {
    call,
    promise: call,
    ...(__JF_DEBUG__
      ? {
          stats: () => ({
            ...gates.stats_(),
            ...(__JF_CONCURRENT__ ? { stack: gates.stacks_.stats() } : {}),
            jobs: jobs.size,
            completion_queues: completed.size,
            queued,
            polls,
            drops,
            dead,
          }),
        }
      : {}),
  };
}
