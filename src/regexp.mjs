import { runtimeError } from "./errors.mjs";

// Private synchronous Core imports. No view or pointer survives an import call.
// No g/y flags: repeated tests never depend on RegExp.lastIndex.
export function regexpImports(memory, strings) {
  const values = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let next = 1;
  const text = (ptr, len) => {
    const m = memory();
    if (!m) throw runtimeError("RT06");
    return decoder.decode(new Uint8Array(m.buffer, ptr >>> 0, len >>> 0));
  };
  const api = {
    compile(ptr, len) {
      const pattern = text(ptr, len);
      let value;
      try {
        value = new RegExp(pattern, "u");
      } catch (error) {
        if (error instanceof SyntaxError) return 0;
        throw error;
      }
      if (next > 0xffffffff) throw runtimeError("RT04");
      const id = next++;
      values.set(id, value);
      return id;
    },
    test(id, ptr, len) {
      return +values.get(id >>> 0).test(text(ptr, len));
    },
    drop(id) {
      values.delete(id >>> 0);
    },
  };
  if (__TARABA_STRINGS__) {
    api["compile-string"] = (id) => {
      let value;
      try {
        value = new RegExp(strings.get(id), "u");
      } catch (error) {
        if (error instanceof SyntaxError) return 0;
        throw error;
      }
      if (next > 0xffffffff) throw runtimeError("RT04");
      const handle = next++;
      values.set(handle, value);
      return handle;
    };
    api["test-string"] = (handle, id) =>
      +values.get(handle >>> 0).test(strings.get(id));
  }
  return api;
}
