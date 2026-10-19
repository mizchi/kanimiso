import { runtimeError } from "./errors.mjs";

// Private synchronous import. Rust borrows the UTF-8 buffer for this call only;
// release neither decodes nor retains it. Throwing terminates guest execution.
export function panicImports(memory, poison) {
  return {
    report(pointer, length) {
      const error = runtimeError("PN01");
      if (__JSRT_DEBUG_ERRORS__ && length) {
        const current = memory();
        if (current)
          error.message +=
            ": " +
            new TextDecoder().decode(
              new Uint8Array(current.buffer, pointer >>> 0, length >>> 0),
            );
      }
      throw poison(error);
    },
  };
}
