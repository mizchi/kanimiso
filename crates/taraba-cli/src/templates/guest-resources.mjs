// Rust-owned resources. Keys are generation-checked again by the Rust store.
export function createGuestResources(drop) {
  const states = new WeakMap(),
    live = new Set(),
    factories = new Map();
  let closed = false;
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
  const active = (lease, type) => {
    const state = states.get(lease);
    if (!state || state.dead || (type !== undefined && state.type !== type))
      fail("RS01");
    return state;
  };
  const finish = (state) => {
    state.dead = true;
    live.delete(state);
    drop(state.type, state.key);
  };
  return {
    define(type, factory) {
      factories.set(type, factory);
    },
    create(type, key) {
      if (closed) fail("RS01");
      const state = { type, key, borrows: 0, dead: false };
      const lease = {
        [Symbol.dispose]() {
          if (state.dead) return;
          if (state.borrows) fail("RS02");
          finish(state);
        },
      };
      Object.assign(lease, factories.get(type)(lease));
      states.set(lease, state);
      live.add(state);
      return lease;
    },
    take(lease, type) {
      if (closed) fail("RS01");
      const state = active(lease, type);
      if (state.borrows) fail("RS02");
      state.dead = true;
      live.delete(state);
      return state.key;
    },
    begin(lease, type) {
      if (closed) fail("RS01");
      const state = active(lease, type);
      state.borrows++;
      return state.key;
    },
    end(lease) {
      const state = states.get(lease);
      if (!state || !state.borrows) fail("RS02");
      // close retires the store owner; Rust Rc borrows keep the value alive.
      state.borrows--;
    },
    close(abandon = false) {
      closed = true;
      if (abandon) {
        for (const state of live) state.dead = true;
        live.clear();
        return;
      }
      let first,
        failed = false;
      // Retire even borrowed owners before runtime shutdown. Their Rust Rc
      // guards release the actual value when cancelled Futures finish dropping.
      for (const state of live) {
        try {
          finish(state);
        } catch (error) {
          if (!failed) {
            first = error;
            failed = true;
          }
        }
      }
      if (failed) throw first;
    },
  };
}
