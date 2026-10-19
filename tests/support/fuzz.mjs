import { withTestApi } from "./core-host.mjs";
import { add } from "./io.mjs";
import assert from "node:assert/strict";
import { createHost } from "../../dist/release.mjs";

// Deterministic state-order fuzz against actual Wasm. Failures include a replay seed
// and the last operations; the oracle models Promise outcomes independently.
export async function fuzz(
  bytes,
  { seed = 1, steps = 10000, fatalAtEnd = false, factory = createHost } = {},
) {
  let state = seed >>> 0,
    operations = 0,
    created = 0,
    drops = 0,
    polls = 0,
    terminal;
  const random = (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * n);
  };
  const history = [],
    records = [],
    byPointer = new Map();
  let reentrant = false,
    inCallback = false,
    current,
    plateau;
  const kinds = [0, 0, 0, 0];
  let reentrantCancels = 0,
    cancelledCount = 0;
  const host = withTestApi(factory({ bindings: { add } }));
  const trace = (op) => {
    history.push(op);
    if (history.length > 80) history.shift();
    operations++;
  };
  const cancel = (rec) => {
    if (!rec || rec.cancelled) return;
    const cancelled = host.cancel(rec.id);
    if (cancelled) {
      rec.cancelled = true;
      cancelledCount++;
    }
    trace(["cancel", rec.id, cancelled]);
  };
  const f = host.imports.jsrt,
    start = f.task_start;
  let allocation;
  f.task_start = (id, ptr) => {
    allocation = { id, ptr };
    start(id, ptr);
  };
  f.probe_event = (event) => {
    if (terminal && event === 1) throw terminal;
    if (!reentrant || inCallback || event !== 0) return;
    inCallback = true;
    reentrantCancels++;
    try {
      if (random(2)) cancel(current);
      else cancel(records[random(records.length)]);
    } finally {
      inCallback = false;
    }
  };
  const { instance } = await WebAssembly.instantiate(bytes, host.imports);
  const raw = instance.exports;
  host.attach(
    new Proxy(
      {},
      {
        get: (_, key) => {
          if (key !== "rt_poll" && key !== "rt_drop") return raw[key];
          return (ptr) => {
            assert.equal(
              host.stats().dead,
              false,
              "no Rust entry after fatal failure",
            );
            const rec = byPointer.get(ptr);
            assert.ok(rec, "only known live Task pointers can enter Rust");
            if (key === "rt_poll") {
              assert.equal(rec.drops, 0);
              polls++;
              current = rec;
              try {
                return raw[key](ptr);
              } finally {
                current = undefined;
              }
            }
            assert.equal(++rec.drops, 1, "Future drops exactly once");
            drops++;
            const value = raw[key](ptr);
            byPointer.delete(ptr);
            return value;
          };
        },
      },
    ),
  );
  const spawn = (kind) => {
    const rec = { kind, drops: 0, cancelled: false, inputDone: false };
    let promise;
    if (kind === 0) {
      rec.value = { seed, task: created };
      rec.rejected = random(4) === 0;
      const input = new Promise((resolve, reject) => {
        rec.finish = rec.rejected ? reject : resolve;
      });
      input.catch(() => {}); // The caller owns input rejection even if cancelled before polling.
      promise = host.promise("await-value", input);
    } else if (kind === 1) {
      rec.value = 42;
      promise = host.promise("self-wake", random(5));
    } else if (kind === 2) {
      const a = random(0xffffffff) | 0,
        b = random(0xffffffff) | 0;
      rec.value = (a + b + 1) | 0;
      promise = host.promise("start", a, b);
    } else {
      rec.value = undefined;
      promise = host.promise("spawn-empty");
    }
    Object.assign(rec, allocation);
    assert.ok(!byPointer.has(rec.ptr), "live Task memory cannot overlap");
    byPointer.set(rec.ptr, rec);
    records.push(rec);
    created++;
    kinds[kind]++;
    promise.then(
      (value) => {
        rec.actual = { value, rejected: false };
      },
      (value) => {
        rec.actual = { value, rejected: true };
      },
    );
    trace(["spawn", kind, rec.id]);
  };
  const resolve = (rec) => {
    if (rec?.finish && !rec.inputDone) {
      rec.inputDone = true;
      rec.finish(rec.value);
      trace(["settle", rec.id, rec.rejected]);
    }
  };
  const flush = async () => {
    for (let i = 0; i < 32; i++) await Promise.resolve();
  };
  const check = (final = false) => {
    for (const rec of records) {
      if (!rec.actual) {
        if (final) assert.fail(`unsettled task ${rec.id}`);
        continue;
      }
      if (rec.cancelled) {
        assert.equal(rec.actual.rejected, true);
        assert.equal(rec.actual.value?.name, "AbortError");
      } else if (terminal && rec.drops === 0) {
        assert.equal(rec.actual.rejected, true);
        assert.equal(rec.actual.value, terminal);
      } else if (rec.fatalDrop) {
        assert.equal(rec.actual.rejected, true);
        assert.equal(rec.actual.value, terminal);
      } else {
        assert.equal(rec.actual.rejected, !!rec.rejected);
        assert.equal(
          rec.actual.value,
          rec.value,
          "identity and result match the independent oracle",
        );
        assert.equal(rec.drops, 1);
      }
    }
  };
  try {
    for (let i = 0; i < steps; i++) {
      reentrant = random(7) === 0;
      const live = records.filter((r) => !r.actual),
        op = random(10);
      if (live.length < 32 && op < 4) spawn(op);
      else if (op < 6) cancel(live[random(live.length)]);
      else if (op < 8) resolve(records[random(records.length)]);
      else if (op === 8) {
        host.call("late_wake");
        trace(["stale-wake"]);
      } else {
        await flush();
        trace(["flush"]);
        check();
      }
      if (i % 128 === 0) {
        await flush();
        check();
        const memory = raw.memory.buffer.byteLength;
        if (i >= 1024) {
          plateau ??= memory;
          assert.equal(
            memory,
            plateau,
            "linear memory must plateau with bounded concurrency",
          );
        }
      }
    }
    reentrant = false;
    // Flush existing completions, then test the same workload's terminal Drop trap.
    for (const rec of records) resolve(rec);
    await flush();
    check();
    for (const rec of records) cancel(rec);
    await flush();
    check(true);
    assert.equal(
      host.stats().live_values +
        host.stats().live_tasks +
        host.stats().live_waits,
      0,
    );
    const memory = raw.memory.buffer.byteLength;
    if (fatalAtEnd) {
      // Keep a subscribed task while another task fails in its destructor.
      spawn(0);
      await flush();
      spawn(1);
      const rec = records.at(-1);
      rec.fatalDrop = true;
      terminal = Error(`fuzz fatal seed ${seed}`);
      await flush();
      assert.equal(host.stats().dead, true);
      check(true);
      const before = polls;
      resolve(records.at(-2));
      await assert.rejects(host.promise("spawn-empty"), (e) => e === terminal);
      await flush();
      assert.equal(polls, before);
      assert.equal(
        host.stats().live_values +
          host.stats().live_tasks +
          host.stats().live_waits,
        0,
      );
    }
    return {
      seed,
      steps,
      operations,
      tasks: created,
      polls,
      drops,
      memory_bytes: memory,
      fatal_at_end: fatalAtEnd,
      kinds,
      cancelled: cancelledCount,
      reentrant_cancels: reentrantCancels,
      passed: true,
    };
  } catch (error) {
    throw new Error(
      `state-order fuzz failed: seed=${seed} steps=${steps} operations=${operations}\ntrace=${JSON.stringify(history)}`,
      { cause: error },
    );
  }
}
