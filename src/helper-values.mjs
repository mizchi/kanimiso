import { runtimeError } from "./errors.mjs";

// Per-instance private roots, independent of the Future executor's value table.
export function createValues(memory) {
  const values = new Map();
  let next = 1;
  const get = (id) => values.get(id >>> 0);
  const drop = (id) => {
    values.delete(id >>> 0);
  };
  const put = (value) => {
    if (next > 0xffffffff) throw runtimeError("RT04");
    const id = next++;
    values.set(id, value);
    return id;
  };
  return {
    get,
    put,
    take(id) {
      const value = get(id);
      drop(id);
      return value;
    },
    memory() {
      const m = memory();
      if (!m) throw runtimeError("RT06");
      return m;
    },
    imports: { clone: (id) => put(get(id)), drop },
  };
}
