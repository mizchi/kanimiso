import { runtimeError } from "./errors.mjs";
import { panicImports } from "./panic.mjs";

// Default scalar WIT/Core profile. JSPI owns the suspended Wasm stack.
// Serial entry also protects LLVM's shared linear-memory stack pointer.
export function createHost({ bindings = {} } = {}, exportNames = []) {
  let dead = false,
    fatal,
    calls = 0,
    completions = 0,
    queued = 0;
  let functions, memory;
  const alive = () => {
    if (dead) throw fatal;
  };
  const poison = (error) => {
    if (!dead) {
      dead = true;
      fatal = error;
      // Queued entries check alive() before touching the dispatch table.
      functions = null;
      if (__JSRT_DEBUG_ERRORS__) memory = null;
    }
    return fatal;
  };
  const app = Object.create(null);
  for (const [name, fn] of Object.entries(bindings)) {
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
  const attach = (exports) => {
    if (functions || dead) throw runtimeError("RT12");
    const next = Object.create(null);
    for (const name of exportNames)
      next[name] = WebAssembly.promising(exports[name]);
    functions = next;
    if (__JSRT_DEBUG_ERRORS__) memory = exports.memory;
  };
  let tail = Promise.resolve();
  const call = (name, ...args) => {
    if (!functions && !dead) return Promise.reject(runtimeError("RT06"));
    queued++;
    const result = tail
      .then(async () => {
        alive();
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
    imports: { app, "taraba:panic": panicImports(() => memory, poison) },
    attach,
    call,
    stats: () => ({ calls, completions, queued, dead }),
  };
}
