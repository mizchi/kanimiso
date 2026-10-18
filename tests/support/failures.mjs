import assert from "node:assert/strict";
import { instantiate } from "./adapter.mjs";
const tick = async (n = 20) => {
  while (n--) await Promise.resolve();
};
const closed = (host) => {
  const s = host.stats();
  assert.equal(s.dead, true);
  assert.equal(s.live_tasks + s.live_waits + s.live_values, 0);
  const table = host.imports.jsrt.__values;
  for (let i = 0; i < table.length; i++) assert.ok(table.get(i) == null);
};
export async function verifyFailures(bytes, factory) {
  const results = [];
  // Cancellation before/during poll, cancellation of another queued task, completion.
  for (const mode of [
    "external",
    "self",
    "other",
    "completion",
    "caught-nested",
  ]) {
    const x = await instantiate(bytes, {}, factory),
      { host } = x;
    const fatal = Error(`drop trap: ${mode}`);
    let polls = 0,
      drops = 0,
      id,
      other;
    x.onEvent((event) => {
      if (event === 1) {
        drops++;
        throw fatal;
      }
      polls++;
      if (mode === "self") host.cancel(id);
      if (mode === "other") host.cancel(other);
      if (mode === "caught-nested") {
        try {
          host.cancel(other);
        } catch {}
      }
    });
    const held = host.promise("await_value", new Promise(() => {}));
    const heldCheck = assert.rejects(held, (e) => e === fatal);
    const p = host.promise("self_wake", mode === "completion" ? 0 : 100);
    [, id] = host.activeTasks();
    const check = assert.rejects(
      p,
      mode === "external" || mode === "self"
        ? { name: "AbortError" }
        : (e) => e === fatal,
    );
    let otherCheck;
    if (mode === "other" || mode === "caught-nested") {
      const q = host.promise("self_wake", 0x80000000);
      other = host.activeTasks().at(-1);
      otherCheck = assert.rejects(q, { name: "AbortError" });
    }
    if (mode === "external")
      assert.throws(
        () => host.cancel(id),
        (e) => e === fatal,
      );
    await Promise.all([heldCheck, check, otherCheck]);
    closed(host);
    assert.equal(drops, 1, "never retry a trapping destructor");
    const before = polls;
    await assert.rejects(host.promise("spawn_empty"), (e) => e === fatal);
    assert.equal(host.cancel(id), false);
    await tick();
    assert.equal(polls, before);
    results.push({ case: mode, passed: true });
  }
  {
    const { host } = await instantiate(bytes, {}, factory);
    const pending = host.promise("await_value", new Promise(() => {}));
    let reason;
    const pendingCheck = pending.catch((e) => {
      reason = e;
    });
    // Bounded 1 MiB linear memory. Fill large blocks then all remaining tiny cells.
    let blocks = 0,
      cells = 0;
    while (host.call("mem_reserve", 4096)) assert.ok(++blocks < 1024);
    while (host.call("mem_reserve", 1)) assert.ok(++cells < 10000);
    let error;
    await assert.rejects(host.promise("spawn_empty"), (e) => {
      error = e;
      return (
        e.name === "WasmOutOfMemoryError" &&
        e.code === "ERR_WASM_OOM" &&
        e.bytes > 0 &&
        e.alignment > 0
      );
    });
    await pendingCheck;
    assert.equal(reason, error);
    closed(host);
    results.push({ case: "Task allocation OOM", blocks, cells, passed: true });
  }
  for (const method of ["oom_sync", "oom_poll"]) {
    const { host } = await instantiate(bytes, {}, factory);
    const pending = host.promise("await_value", new Promise(() => {}));
    let reason, error;
    const check = pending.catch((e) => {
      reason = e;
    });
    await assert.rejects(host.promise(method), (e) => {
      error = e;
      return e instanceof WebAssembly.RuntimeError;
    });
    await check;
    assert.equal(reason, error);
    closed(host);
    await assert.rejects(host.promise("spawn_empty"), (e) => e === error);
    results.push({ case: method, passed: true });
  }
  {
    const { host } = await instantiate(bytes, { maxValues: 1 }, factory);
    let reason;
    const p = host.promise("await_value", new Promise(() => {}));
    await assert.rejects(p, (e) => {
      reason = e;
      return e.code === "ERR_WASM_OOM";
    });
    closed(host);
    await assert.rejects(host.promise("spawn_empty"), (e) => e === reason);
    results.push({ case: "externref root OOM", passed: true });
  }
  return { all_passed: true, cases: results };
}
