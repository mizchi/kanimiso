// One isolated Node process per sample. The same two-add algorithm and bindings
// are used for every backend. RSS includes engine/JIT pages and is not exact stack accounting.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [loader, wasm, countText, serializedText] = process.argv.slice(2);
const count = Number(countText),
  serialized = serializedText === "true";
assert.ok(typeof globalThis.gc === "function");
let paused = false;
const requests = [];
const { instantiate } = await import(pathToFileURL(loader));
const host = await instantiate(new WebAssembly.Module(readFileSync(wasm)), {
  bindings: {
    add: (a, b) =>
      paused
        ? new Promise((resolve) => requests.push({ a, b, resolve }))
        : Promise.resolve((a + b) | 0),
  },
});
const submit = (n) => host.promise("run", n, -n);
assert.ok(
  (await Promise.all(Array.from({ length: 64 }, (_, n) => submit(n)))).every(
    (v) => v === 1,
  ),
);
const memory = () => {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage();
};
const before = memory();
paused = true;
const jobs = Array.from({ length: count }, (_, n) => submit(n));
for (let i = 0; i < 200; i++) await Promise.resolve();
assert.equal(requests.length, serialized ? 1 : count);
const parked = memory();
paused = false;
for (const r of requests) r.resolve((r.a + r.b) | 0);
assert.ok((await Promise.all(jobs)).every((v) => v === 1));
const after = memory();
console.log(
  JSON.stringify({
    submitted: count,
    active_io: requests.length,
    warmup: 64,
    before,
    parked,
    after,
    delta: Object.fromEntries(
      Object.keys(before).map((k) => [k, parked[k] - before[k]]),
    ),
  }),
);
