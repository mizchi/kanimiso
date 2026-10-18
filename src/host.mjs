import { runtimeError } from "./errors.mjs";
// Same public contract as js-local-hardened. Optimize deployment size using two
// direct maps, a four-state Task and a simple bounded shift queue.
const CANCELLED = -1,
  PENDING = 0,
  READY = 1,
  COMMITTED = 2;
export function createHost({
  bindings = {},
  deferredAdd = (a, b) => Promise.resolve((a + b) | 0),
  tokens = {},
  maxValues = 0xfffffffe,
} = {}) {
  const { first = 1, last = 0xffffffff } = tokens;
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1 ||
    last > 0xffffffff ||
    first > last
  )
    throw runtimeError("RT01", RangeError);
  if (!Number.isInteger(maxValues) || maxValues < 1 || maxValues > 0xfffffffe)
    throw runtimeError("RT02", RangeError);
  const tasks = new Map(),
    waits = new Map(),
    queue = [],
    free = [],
    refs = [];
  const table = new WebAssembly.Table(
    { element: "externref", initial: 128 },
    undefined,
  );
  const counts = { polls: 0, wakes: 0, requests: 0, completions: 0 };
  let exports,
    fatal,
    dead = false,
    scheduled = false,
    running,
    id = first,
    next = 1,
    live = 0,
    peak = 0;
  const alive = () => {
    if (dead) throw fatal;
  };
  const poison = (error) => {
    if (!dead) {
      dead = true;
      fatal = error;
      for (const t of tasks.values())
        if (t.state >= PENDING && t.state < COMMITTED) t.reject(error);
      tasks.clear();
      waits.clear();
      queue.length = free.length = 0;
      for (let i = 1; i < next; i++) {
        table.set(i, undefined);
        refs[i] = 0;
      }
      live = 0;
      exports = undefined;
    }
    return fatal;
  };
  const guard =
    (fn) =>
    (...args) => {
      alive();
      try {
        const result = fn(...args);
        alive();
        return result;
      } catch (error) {
        throw poison(error);
      }
    };
  const oom = (bytes, alignment) => {
    throw Object.assign(runtimeError("RT03", RangeError), {
      name: "WasmOutOfMemoryError",
      code: "ERR_WASM_OOM",
      bytes,
      alignment,
    });
  };
  const exhausted = () => runtimeError("RT04", RangeError);
  const put = (map, value) => {
    if (id > last) return 0;
    const key = id++;
    map.set(key, value);
    return key;
  };
  const root = (value) => {
    if (value === undefined) return 0;
    if (live === maxValues) oom();
    const slot = free.length ? free.pop() : next;
    if (slot >= table.length)
      try {
        table.grow(table.length);
      } catch {
        oom();
      }
    if (slot === next) next++;
    table.set(slot, value);
    refs[slot] = 1;
    peak = Math.max(peak, ++live);
    return slot;
  };
  const get = (slot) => table.get(slot >>> 0);
  const release = (slot) => {
    slot >>>= 0;
    if (!slot) return;
    if (!refs[slot]) throw runtimeError("RT05");
    if (!--refs[slot]) {
      table.set(slot, undefined);
      free.push(slot);
      live--;
    }
  };
  const take = (slot) => {
    const value = get(slot);
    release(slot);
    return value;
  };
  const enter = guard((name, ...args) => {
    if (!exports || typeof exports[name] !== "function")
      throw runtimeError("RT06", Error, name);
    return exports[name](...args);
  });
  const schedule = () => {
    if (!scheduled && !dead) {
      scheduled = true;
      queueMicrotask(drain);
    }
  };
  const wake = (key) => {
    key >>>= 0;
    const t = tasks.get(key);
    if (t && t.state === PENDING && !t.queued && !dead) {
      counts.wakes++;
      t.queued = true;
      queue.push(key);
      schedule();
    }
  };
  function drain() {
    scheduled = false;
    if (dead) return;
    // Snapshot length: wakes during poll always run in a later microtask.
    let n = Math.min(64, queue.length);
    try {
      while (n--) {
        const key = queue.shift(),
          t = tasks.get(key);
        if (!t || t.state !== PENDING) continue;
        t.queued = false;
        running = t;
        counts.polls++;
        const done = enter("rt_poll", t.ptr);
        running = undefined;
        if (done || t.state === CANCELLED) {
          if (t.state !== CANCELLED && t.state !== READY)
            throw runtimeError("RT07");
          enter("rt_drop", t.ptr);
          tasks.delete(key);
          if (t.state === READY) {
            t.state = COMMITTED;
            (t.rejected ? t.reject : t.resolve)(t.value);
          }
        } else if (t.state === READY) throw runtimeError("RT08");
      }
    } catch (error) {
      running = undefined;
      poison(error);
      return;
    }
    if (queue.length) schedule();
  }
  const cancelLive = guard((key) => {
    key >>>= 0;
    const t = tasks.get(key);
    if (!t || t.state !== PENDING) return false;
    t.state = CANCELLED;
    t.reject(Object.assign(runtimeError("RT09"), { name: "AbortError" }));
    if (running !== t) {
      enter("rt_drop", t.ptr);
      tasks.delete(key);
    }
    return true;
  });
  const settle = (key, value, rejected) => {
    if (dead || !waits.has(key)) return;
    const ptr = waits.get(key);
    waits.delete(key);
    counts.completions++;
    try {
      enter("rt_settle", ptr, value, rejected);
    } catch (error) {
      poison(error);
    }
  };
  const jsrt = {
    __values: table,
    __root: root,
    __take: take,
    retain(slot) {
      slot >>>= 0;
      if (slot) {
        if (!refs[slot]) throw runtimeError("RT05");
        refs[slot]++;
      }
    },
    release,
    oom,
    exhausted,
    number: (v) => v,
    as_i32: (v) =>
      typeof v === "number" &&
      Number.isInteger(v) &&
      v >= -2147483648 &&
      v <= 2147483647
        ? v
        : NaN,
    task_new() {
      const task = Promise.withResolvers();
      task.promise.catch(() => {});
      task.state = PENDING;
      task.ptr = 0;
      return put(tasks, task);
    },
    task_promise: (key) =>
      key ? tasks.get(key >>> 0).promise : Promise.reject(exhausted()),
    task_start(key, ptr) {
      tasks.get(key >>> 0).ptr = ptr >>> 0;
      wake(key);
    },
    task_wake: wake,
    task_cancel: (key) => (cancelLive(key) ? 1 : 0),
    task_finish(key, value, rejected) {
      const t = tasks.get(key >>> 0);
      if (t.state === READY) throw runtimeError("RT10");
      if (t.state === PENDING) {
        t.state = READY;
        t.value = value;
        t.rejected = rejected !== 0;
      }
    },
    subscribe(promise, ptr) {
      const key = put(waits, ptr >>> 0);
      if (key)
        Promise.resolve(promise).then(
          (v) => settle(key, v, 0),
          (e) => settle(key, e, 1),
        );
      else Promise.resolve(promise).catch(() => {});
      return key;
    },
    unsubscribe: (key) => {
      waits.delete(key >>> 0);
    },
    deferred_add(a, b) {
      counts.requests++;
      return deferredAdd(a, b);
    },
  };
  for (const key in jsrt)
    if (typeof jsrt[key] === "function") jsrt[key] = guard(jsrt[key]);
  const call = (name, ...args) => {
    alive();
    if (name.startsWith("rt_")) throw runtimeError("RT11");
    return enter(name, ...args);
  };
  const app = Object.create(null);
  for (const [name, fn] of Object.entries(bindings)) {
    if (typeof fn !== "function") throw runtimeError("RT14", TypeError);
    app[name] = guard(fn);
  }
  return {
    imports: { jsrt, app },
    root: jsrt.__root,
    get: guard(get),
    take: jsrt.__take,
    // prettier-ignore
    "release": jsrt.release,
    call,
    promise(name, ...args) {
      try {
        return Promise.resolve(call(name, ...args));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    cancel: (key) => (dead ? false : cancelLive(key)),
    activeTasks: () => [...tasks.keys()],
    attach(wasm) {
      if (exports || dead) throw runtimeError("RT12");
      if (
        typeof SharedArrayBuffer !== "undefined" &&
        wasm.memory?.buffer instanceof SharedArrayBuffer
      )
        throw runtimeError("RT13");
      exports = wasm;
    },
    stats: () => ({
      ...counts,
      live_values: live,
      peak_values: peak,
      value_table_slots: next - 1,
      value_table_capacity: table.length,
      live_tasks: tasks.size,
      live_waits: waits.size,
      issued_ids: id - first,
      dead,
    }),
  };
}
