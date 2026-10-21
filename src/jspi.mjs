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
  const noop = () => {};
  const stopped = Promise.withResolvers();
  stopped.promise.catch(noop);
  const alive = () => {
    if (dead) throw fatal;
  };
  const poison = (error) => {
    if (!dead) {
      dead = true;
      fatal = error;
      bindings = undefined;
      stopped.reject(error);
      // Queued entries check alive() before touching the dispatch table.
      functions = null;
      if (__JSRT_DEBUG_ERRORS__) memory = null;
    }
    return fatal;
  };
  const app = Object.create(null);
  for (const name of Object.keys(bindings)) {
    app[name] = new WebAssembly.Suspending(async (...args) => {
      alive();
      try {
        const fn = bindings[name];
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
    if (dead) return Promise.reject(fatal);
    if (!functions) return Promise.reject(runtimeError("RT06"));
    queued++;
    const pending = tail.then(async () => {
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
    });
    // Keep execution serialized even when public calls are disposed early.
    tail = pending.catch(noop);
    const result = Promise.race([pending, stopped.promise]).finally(
      () => queued--,
    );
    result.catch(noop);
    return result;
  };
  return {
    imports: { app, "taraba:panic": panicImports(() => memory, poison) },
    attach,
    dispose() {
      if (!dead) poison(runtimeError("RT13"));
    },
    call,
    stats: () => ({ calls, completions, queued, dead }),
  };
}
