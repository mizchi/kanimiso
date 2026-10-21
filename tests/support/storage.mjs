import assert from "node:assert/strict";
import { asyncCases } from "./async-contract.mjs";
import { instantiate } from "./adapter.mjs";
const flush = async (condition) => {
  for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve();
  assert.ok(condition());
};
const clean = (host) => {
  const s = host.stats();
  assert.equal(s.live_tasks + s.live_waits + s.live_values, 0);
  assert.equal(s.dead, false);
  const table = host.imports.jsrt.__values;
  for (let i = 0; i < table.length; i++) assert.ok(table.get(i) == null);
};
export async function verifyStorage(bytes, factory, backend) {
  if (backend === "heap") return { applicable: false };
  const { host, api } = await instantiate(bytes, {}, factory);
  const reserve = (size, align = 16) =>
    host.call("storage_reserve", size, align) >>> 0;
  const release = (ptr, size, align = 16) =>
    host.call("storage_release", ptr, size, align);
  const used = () => host.call("storage_used");
  const view = () => new Uint8Array(api.memory.buffer);
  const fill = (p, n, v) => {
    assert.ok(p > 0 && p + n <= view().length);
    view().fill(v, p, p + n);
  };
  const verify = (p, n, v) => {
    assert.equal(view().subarray(p, p + n).length, n);
    for (const byte of view().subarray(p, p + n)) assert.equal(byte, v);
  };
  assert.equal(used(), 0);
  let checkedBytes = 0;
  if (backend === "pool") {
    const pointers = [];
    for (let i = 0; i < 1024; i++) {
      const p = reserve(96);
      fill(p, 96, i & 255);
      pointers.push(p);
    }
    assert.equal(used(), 1024);
    assert.equal(reserve(1), 0);
    assert.equal(reserve(129), 0);
    assert.equal(reserve(1, 128), 0);
    for (let i = 0; i < 1024; i += 2) release(pointers[i], 96);
    for (let i = 0; i < 512; i++) {
      const p = reserve(64, 64);
      assert.ok(pointers.filter((_, j) => j % 2 === 0).includes(p));
      assert.equal(p % 64, 0);
      fill(p, 64, 42);
    }
    for (let i = 1; i < 1024; i += 2) {
      verify(pointers[i], 96, i & 255);
      checkedBytes += 96;
      release(pointers[i], 96);
    }
    for (let i = 0; i < 1024; i += 2) {
      verify(pointers[i], 64, 42);
      checkedBytes += 64;
      release(pointers[i], 64, 64);
    }
  } else {
    const live = [];
    for (const align of [1, 2, 4, 8, 16, 32, 64, 128, 256, 4096, 65536]) {
      const size = 17 + live.length * 13,
        p = reserve(size, align);
      assert.equal(p % align, 0);
      fill(p, size, live.length + 1);
      live.push({ p, size, align, value: live.length + 1 });
    }
    const sorted = live.toSorted((a, b) => a.p - b.p);
    for (let i = 1; i < sorted.length; i++)
      assert.ok(sorted[i - 1].p + sorted[i - 1].size <= sorted[i].p);
    for (const b of live.toReversed()) {
      verify(b.p, b.size, b.value);
      checkedBytes += b.size;
      release(b.p, b.size, b.align);
    }
    const quarter = 32768,
      a = reserve(quarter),
      b = reserve(quarter),
      c = reserve(quarter),
      d = reserve(quarter);
    fill(d, quarter, 77);
    release(a, quarter);
    release(c, quarter);
    assert.equal(reserve(49152), 0);
    release(b, quarter);
    const merged = reserve(98304);
    assert.equal(merged, a);
    fill(merged, 98304, 42);
    verify(d, quarter, 77);
    checkedBytes += quarter;
    release(merged, 98304);
    release(d, quarter);
    const all = reserve(131072);
    fill(all, 131072, 55);
    verify(all, 131072, 55);
    checkedBytes += 131072;
    release(all, 131072);
  }
  assert.equal(used(), 0);
  assert.equal(reserve(0), 0);
  assert.equal(reserve(0x7fffffff), 0);
  assert.equal(used(), 0);
  // Exercise actual Futures while a long-lived task keeps the storage nonempty.
  let resolve;
  const input = new Promise((r) => {
    resolve = r;
  });
  const held = api.awaitValue(input);
  await flush(() => host.stats().live_waits === 1);
  for (let i = 0; i < 128; i++)
    await Promise.all(Array.from({ length: 32 }, () => api.spawnEmpty()));
  assert.ok(used() > 0);
  resolve(42);
  assert.equal(await held, 42);
  assert.equal(used(), 0);
  clean(host);
  const reservedBytes = host.call("storage_reserved"),
    memory = api.memory.buffer.byteLength;
  // The pool boxes oversized captured Futures; the arena stores them inline.
  const big = host.promise("self-wake", 0x40000000);
  assert.equal(await big, 42);
  assert.equal(used(), 0);
  clean(host);
  return {
    applicable: true,
    all_passed: true,
    backend,
    checked_bytes: checkedBytes,
    reserved_bytes: reservedBytes,
    payload_bytes: 131072,
    held_task_reuse_spawns: 4096,
    large_future: backend === "pool" ? "boxed and fulfilled" : "fulfilled",
    memory_bytes: memory,
  };
}
