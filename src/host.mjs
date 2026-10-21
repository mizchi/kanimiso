import { runtimeError } from "./errors.mjs";
import { panicImports } from "./panic.mjs";
// Same public contract as js-local-hardened. Optimize deployment size using two
// direct maps, a four-state Task and a simple bounded shift queue.
const CANCELLED = -1,
  PENDING = 0,
  READY = 1,
  COMMITTED = 2;
export function createHost({
  bindings = {},
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
  const table = new WebAssembly.Table({ element: "externref", initial: 128 });
  const counts = { polls: 0, wakes: 0, requests: 0, completions: 0 };
  let exports,
    fatal,
    closing,
    depth = 0,
    dead = false,
    scheduled = false,
    running,
    enteringScope,
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
      bindings = undefined;
      for (const t of tasks.values()) {
        if (__TARABA_ABORT__ && t.scope) {
          t.scope.close();
          t.scope.controller.abort(error);
        }
        if (t.state >= PENDING && t.state < COMMITTED) t.reject(error);
      }
      tasks.clear();
      waits.clear();
      queue.length = free.length = 0;
      for (let i = 1; i < next; i++) {
        table.set(i);
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
    const slot = free.pop() ?? next;
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
  const release = (slot) => {
    slot >>>= 0;
    if (!slot) return;
    if (!refs[slot]) throw runtimeError("RT05");
    if (!--refs[slot]) {
      table.set(slot);
      free.push(slot);
      live--;
    }
  };
  const take = (slot) => {
    const value = table.get(slot >>> 0);
    release(slot);
    return value;
  };
  const enter = guard((name, ...args) => {
    if (!exports) throw runtimeError("RT06");
    depth++;
    try {
      return exports[name](...args);
    } finally {
      depth--;
      finishClose();
    }
  });
  const finishClose = () => {
    if (closing && !depth && !running && !tasks.size && !dead) poison(closing);
  };
  const dropFrame = (t) => {
    if (__TARABA_ABORT__) {
      const previous = enteringScope;
      enteringScope = t.scope;
      try {
        enter("rt_drop", t.ptr);
      } finally {
        enteringScope = previous;
      }
    } else enter("rt_drop", t.ptr);
  };
  const schedule = () => {
    // Only wake on a live host or a successful drain with queued work calls this.
    if (!scheduled) {
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
    // poison clears the queue synchronously; a previously scheduled drain is empty.
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
        if (done || t.state === CANCELLED) {
          if (t.state !== CANCELLED && t.state !== READY)
            throw runtimeError("RT07");
          dropFrame(t);
          tasks.delete(key);
          if (__TARABA_ABORT__) t.scope?.tasks.delete(key);
        } else if (t.state === READY) throw runtimeError("RT08");
        // Keep the frame active through Drop: a reentrant dispose may cancel it,
        // but must not recursively enter the same destructor.
        running = undefined;
        finishClose();
        if (t.state === READY) {
          t.state = COMMITTED;
          (t.rejected ? t.reject : t.resolve)(t.value);
        }
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
    t.reject(
      closing ??
        (__TARABA_ABORT__ && t.scope?.controller.signal.aborted
          ? t.scope.controller.signal.reason
          : Object.assign(runtimeError("RT09"), { name: "AbortError" })),
    );
    if (running !== t) {
      dropFrame(t);
      tasks.delete(key);
      if (__TARABA_ABORT__) t.scope?.tasks.delete(key);
    }
    return true;
  });
  const cancel = __TARABA_ABORT__
    ? (key) => {
        const t = tasks.get(key >>> 0);
        if (!t || t.state !== PENDING) return false;
        if (t.scope)
          t.scope.abort(
            Object.assign(runtimeError("RT09"), { name: "AbortError" }),
          );
        else cancelLive(key);
        return true;
      }
    : cancelLive;
  const settle = (key, value, rejected) => {
    const wait = waits.get(key);
    if (dead || wait === undefined) return;
    waits.delete(key);
    counts.completions++;
    const previous = __TARABA_ABORT__ ? enteringScope : undefined;
    try {
      if (__TARABA_ABORT__) enteringScope = wait.scope;
      enter("rt_settle", __TARABA_ABORT__ ? wait.ptr : wait, value, rejected);
    } catch (error) {
      poison(error);
    } finally {
      if (__TARABA_ABORT__) enteringScope = previous;
    }
  };
  const jsrt = {
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
      const key = put(tasks, task);
      if (__TARABA_ABORT__) {
        task.scope = enteringScope ?? running?.scope;
        if (key) task.scope?.tasks.add(key);
      }
      return key;
    },
    task_promise: (key) =>
      key ? tasks.get(key >>> 0).promise : Promise.reject(exhausted()),
    task_start(key, ptr) {
      tasks.get(key >>> 0).ptr = ptr >>> 0;
      if (
        closing ||
        (__TARABA_ABORT__ &&
          tasks.get(key >>> 0).scope?.controller.signal.aborted)
      )
        cancelLive(key);
      else wake(key);
    },
    task_wake: wake,
    task_cancel: (key) => (cancel(key) ? 1 : 0),
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
      const key = put(
        waits,
        __TARABA_ABORT__
          ? { ptr: ptr >>> 0, scope: enteringScope ?? running?.scope }
          : ptr >>> 0,
      );
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
  };
  for (const key in jsrt) jsrt[key] = guard(jsrt[key]);
  jsrt.__values = table;
  const invoke = (name, ...args) => {
    alive();
    if (closing) throw closing;
    if (name.startsWith("rt_")) throw runtimeError("RT11");
    return enter(name, ...args);
  };
  // Compiled away in the ordinary runtime. Each entry has a scope assigned
  // synchronously by task_new, including tasks spawned during subsequent polls.
  const call = __TARABA_ABORT__
    ? (name, signal, ...args) => {
        alive();
        if (signal?.aborted) return Promise.reject(signal.reason);
        const controller = new AbortController();
        const scope = {
          controller,
          tasks: new Set(),
          context: { signal: controller.signal },
          close: () => signal?.removeEventListener("abort", abort),
          abort(reason) {
            if (controller.signal.aborted) return;
            controller.abort(reason);
            for (const key of scope.tasks) cancelLive(key);
            scope.close();
          },
        };
        const abort = () => scope.abort(signal.reason);
        signal?.addEventListener("abort", abort, { once: true });
        const previous = enteringScope;
        enteringScope = scope;
        try {
          const result = invoke(name, ...args);
          Promise.resolve(result).then(scope.close, scope.close);
          return result;
        } catch (error) {
          scope.close();
          throw error;
        } finally {
          enteringScope = previous;
        }
      }
    : invoke;
  const app = Object.create(null);
  for (const name of Object.keys(bindings)) {
    app[name] = guard((...args) => {
      counts.requests++;
      const fn = bindings[name];
      return __TARABA_ABORT__
        ? fn(...args, (enteringScope ?? running?.scope)?.context)
        : fn(...args);
    });
  }
  return {
    imports: {
      jsrt,
      app,
      "taraba:panic": panicImports(() => exports?.memory, poison),
    },
    call,
    dispose() {
      if (dead || closing) return;
      closing = runtimeError("RT13");
      try {
        for (const [key, t] of tasks) {
          if (__TARABA_ABORT__ && t.scope) {
            t.scope.close();
            t.scope.controller.abort(closing);
          }
          if (t.state === READY) t.state = PENDING;
          cancelLive(key);
        }
        finishClose();
      } catch (error) {
        throw poison(error);
      }
    },
    cancel: (key) => (dead || closing ? false : cancel(key)),
    activeTasks: () => [...tasks.keys()],
    attach(wasm) {
      if (exports || dead) throw runtimeError("RT12");
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
