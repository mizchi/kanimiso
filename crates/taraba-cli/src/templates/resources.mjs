// App-local resource leases. These checks enforce ownership and instance identity,
// not the WIT function types already checked by TypeScript.
export function createResources() {
  const states = new WeakMap(),
    owners = new WeakMap(),
    held = new Set();
  const fail = (code) => {
    throw Object.assign(
      new Error(
        code +
          " https://github.com/mizchi/taraba/blob/main/docs/error-codes.md#" +
          code.toLowerCase(),
      ),
      { code },
    );
  };
  const active = (lease) => {
    const state = states.get(lease);
    if (!state || state.owner === "dead" || state.owner === "host")
      fail("RS01");
    return state;
  };
  const exclusive = (state, owner) => {
    if (state.owner !== owner || state.borrows) fail("RS02");
  };
  const finish = (state) => {
    const value = state.value;
    state.value = undefined;
    state.owner = "dead";
    owners.delete(value);
    held.delete(state);
    value[Symbol.dispose]();
  };
  return {
    wrap(value) {
      if (owners.has(value)) fail("RS03");
      const state = { value, owner: "js", borrows: 0 };
      const lease = {
        [Symbol.dispose]() {
          if (state.owner === "dead") return;
          exclusive(state, "js");
          finish(state);
        },
      };
      states.set(lease, state);
      owners.set(value, state);
      return lease;
    },
    take(lease) {
      const s = active(lease);
      exclusive(s, "js");
      s.owner = "rust";
      held.add(s);
      return lease;
    },
    give(lease) {
      const s = active(lease);
      exclusive(s, "rust");
      s.owner = "js";
      held.delete(s);
      return lease;
    },
    begin(lease) {
      const s = active(lease);
      if (s.owner !== "js") fail("RS02");
      s.borrows++;
      held.add(s);
      return lease;
    },
    end(lease) {
      const s = active(lease);
      if (!s.borrows) fail("RS02");
      s.borrows--;
      if (!s.borrows) held.delete(s);
    },
    peek(lease) {
      return active(lease).value;
    },
    toHostOwn(lease) {
      const s = active(lease);
      exclusive(s, "js");
      const value = s.value;
      s.value = undefined;
      s.owner = "host";
      owners.delete(value);
      return value;
    },
    close() {
      let first,
        failed = false;
      for (const state of held) {
        try {
          if (state.owner === "rust") finish(state);
          else state.borrows = 0;
        } catch (error) {
          if (!failed) {
            first = error;
            failed = true;
          }
        }
      }
      held.clear();
      if (failed) throw first;
    },
    drop(lease) {
      const s = active(lease);
      exclusive(s, "rust");
      finish(s);
    },
  };
}
