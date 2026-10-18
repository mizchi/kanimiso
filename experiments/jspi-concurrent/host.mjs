import { createStacks, failure } from "./stack.mjs";
const debug = typeof __JSC_DEBUG__ === "undefined" ? true : __JSC_DEBUG__;

export async function instantiate(source, { bindings = {} } = {}) {
  if (
    typeof WebAssembly.promising !== "function" ||
    typeof WebAssembly.Suspending !== "function"
  )
    throw failure("JC6");
  let dead = false,
    fatal,
    calls = 0,
    completions = 0;
  const functions = Object.create(null),
    pending = new Set();
  const alive = () => {
    if (dead) throw fatal;
  };
  const stacks = createStacks(alive);
  const poison = (error) => {
    if (!dead) {
      dead = true;
      fatal = error;
      for (const reject of pending) reject(fatal);
      pending.clear();
      stacks.close();
      for (const name in functions) delete functions[name];
    }
    return fatal;
  };
  const app = Object.create(null);
  for (const [name, fn] of Object.entries(bindings)) {
    if (typeof fn !== "function") throw failure("JC4");
    app[name] = new WebAssembly.Suspending(
      (...args) =>
        new Promise((resolve, reject) => {
          // Reject all parked entries on first-fatal, even if their I/O never finishes.
          if (dead) {
            reject(fatal);
            return;
          }
          pending.add(reject);
          try {
            alive();
            Promise.resolve(fn(...args)).then(
              (value) => {
                if (pending.delete(reject)) resolve(value);
              },
              (error) => {
                poison(error);
              },
            );
          } catch (error) {
            poison(error);
          }
        }),
    );
  }
  const loaded = await WebAssembly.instantiate(source, {
    app,
    "taraba:jspi-stack": stacks.imports,
  });
  const instance =
    loaded instanceof WebAssembly.Instance ? loaded : loaded.instance;
  stacks.attach(instance.exports);
  for (const [name, value] of Object.entries(instance.exports))
    if (
      typeof value === "function" &&
      !name.startsWith("rt_") &&
      !name.startsWith("cabi_")
    )
      functions[name] = WebAssembly.promising(value);
  const call = (name, ...args) =>
    Promise.resolve().then(async () => {
      alive();
      if (
        name.startsWith("rt_") ||
        name.startsWith("cabi_") ||
        typeof functions[name] !== "function"
      )
        throw failure("JC4");
      if (debug) calls++;
      try {
        const result = await functions[name](...args);
        alive();
        if (debug) completions++;
        return result;
      } catch (error) {
        throw poison(error);
      }
    });
  return {
    call,
    promise: call,
    ...(debug
      ? {
          stats: () => ({
            ...stacks.stats(),
            pending: pending.size,
            calls,
            completions,
            dead,
          }),
        }
      : {}),
  };
}
