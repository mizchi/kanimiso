// Single-agent JS latch. A wake may arrive before or after park; neither is lost.
// IDs never wrap/reuse, so late completions cannot wake an unrelated invocation.
export class Gates {
  #next = 0;
  #gates = new Map();
  #dead = false;
  #fatal;
  #limit;
  #parks = 0;
  constructor(limit = 0x7fffffff) {
    this.#limit = limit;
  }
  open_() {
    if (this.#dead) throw this.#fatal;
    if (this.#next === this.#limit) throw Error("gate IDs exhausted");
    const id = ++this.#next;
    this.#gates.set(id, { notified_: false, waiter_: null });
    return id;
  }
  signal_(id) {
    const gate = this.#gates.get(id);
    if (!gate) return;
    if (gate.waiter_) {
      const { resolve_: resolve } = gate.waiter_;
      gate.waiter_ = null;
      resolve();
    } else gate.notified_ = true;
  }
  park_(id) {
    if (this.#dead) throw this.#fatal;
    const gate = this.#gates.get(id);
    if (!gate) throw Error("unknown gate");
    if (gate.waiter_) throw Error("already parked");
    this.#parks++;
    if (gate.notified_) {
      gate.notified_ = false;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      gate.waiter_ = { resolve_: resolve, reject_: reject };
    });
  }
  close_(id) {
    const gate = this.#gates.get(id);
    this.#gates.delete(id);
    gate?.waiter_?.reject_(Error("gate closed"));
  }
  retire_(reason) {
    if (this.#dead) return;
    this.#dead = true;
    this.#fatal = reason;
    for (const gate of this.#gates.values()) gate.waiter_?.reject_(reason);
    this.#gates.clear();
  }
  stats_() {
    return { gates: this.#gates.size, parks: this.#parks, dead: this.#dead };
  }
}
