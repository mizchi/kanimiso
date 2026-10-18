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
  open() {
    if (this.#dead) throw this.#fatal;
    if (this.#next === this.#limit) throw Error("gate IDs exhausted");
    const id = ++this.#next;
    this.#gates.set(id, { notified: false, waiter: null });
    return id;
  }
  signal(id) {
    const gate = this.#gates.get(id);
    if (!gate) return;
    if (gate.waiter) {
      const { resolve } = gate.waiter;
      gate.waiter = null;
      resolve();
    } else gate.notified = true;
  }
  park(id) {
    if (this.#dead) throw this.#fatal;
    const gate = this.#gates.get(id);
    if (!gate) throw Error("unknown gate");
    if (gate.waiter) throw Error("already parked");
    this.#parks++;
    if (gate.notified) {
      gate.notified = false;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      gate.waiter = { resolve, reject };
    });
  }
  close(id) {
    const gate = this.#gates.get(id);
    this.#gates.delete(id);
    gate?.waiter?.reject(Error("gate closed"));
  }
  retire(reason) {
    if (this.#dead) return;
    this.#dead = true;
    this.#fatal = reason;
    for (const gate of this.#gates.values()) gate.waiter?.reject(reason);
    this.#gates.clear();
  }
  stats() {
    return { gates: this.#gates.size, parks: this.#parks, dead: this.#dead };
  }
}
