import { runtimeError } from "./errors.mjs";

// Default scalar WIT/Core profile. JSPI owns the suspended Wasm stack.
// Serial entry also protects LLVM's shared linear-memory stack pointer.
export async function instantiate(
  source,
  { bindings = {}, compileOptions } = {},
) {
  if (
    typeof WebAssembly.promising !== "function" ||
    typeof WebAssembly.Suspending !== "function"
  )
    throw runtimeError("RT15", TypeError);
  let dead = false,
    fatal,
    calls = 0,
    completions = 0,
    queued = 0;
  const functions = Object.create(null);
  const alive = () => {
    if (dead) throw fatal;
  };
  const poison = (error) => {
    if (!dead) {
      dead = true;
      fatal = error;
      for (const name in functions) delete functions[name];
    }
    return fatal;
  };
  const app = Object.create(null);
  for (const [name, fn] of Object.entries(bindings)) {
    if (typeof fn !== "function") throw runtimeError("RT14", TypeError);
    app[name] = new WebAssembly.Suspending(async (...args) => {
      alive();
      try {
        const value = await fn(...args);
        alive();
        return value;
      } catch (error) {
        throw poison(error);
      }
    });
  }
  const loaded = await WebAssembly.instantiate(source, { app }, compileOptions);
  const instance =
    loaded instanceof WebAssembly.Instance ? loaded : loaded.instance;
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    instance.exports.memory?.buffer instanceof SharedArrayBuffer
  )
    throw runtimeError("RT13");
  for (const [name, value] of Object.entries(instance.exports)) {
    if (
      typeof value === "function" &&
      !name.startsWith("rt_") &&
      !name.startsWith("cabi_")
    )
      functions[name] = WebAssembly.promising(value);
  }
  let tail = Promise.resolve();
  const call = (name, ...args) => {
    queued++;
    const result = tail
      .then(async () => {
        alive();
        if (name.startsWith("rt_") || name.startsWith("cabi_"))
          throw runtimeError("RT11");
        if (typeof functions[name] !== "function")
          throw runtimeError("RT06", Error, name);
        calls++;
        try {
          const value = await functions[name](...args);
          alive();
          completions++;
          return value;
        } catch (error) {
          throw poison(error);
        }
      })
      .finally(() => queued--);
    // A failed call never leaves an unhandled queue-tail rejection.
    tail = result.catch(() => {});
    return result;
  };
  return {
    call,
    promise: call,
    stats: () => ({ calls, completions, queued, dead }),
  };
}
