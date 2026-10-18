import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const backend of ["intrusive"])
  test(`${backend}: 1024 pinned slots, live bytes, invalid layout and mixed reuse`, () => {
    const dir = mkdtempSync(join(tmpdir(), "jsrt-slots-"));
    try {
      const file = join(dir, "slots.wasm");
      execFileSync(".cache/toolchains/binaryen-version_133/bin/wasm-as", [
        "src/intrusive.wat",
        "-o",
        file,
      ]);
      const memory = new WebAssembly.Memory({ initial: 4, maximum: 16 });
      const { allocate, free, used } = new WebAssembly.Instance(
        new WebAssembly.Module(readFileSync(file)),
        { app: { memory } },
      ).exports;
      const view = new Uint8Array(memory.buffer),
        base = 65536,
        live = new Map();
      for (let i = 0; i < 1024; i++) {
        const p = allocate(base, 128, 64);
        assert.ok(p >= base && p + 128 <= base + 131072 && p % 64 === 0);
        assert.equal(live.has(p), false);
        view.fill(i & 255, p, p + 128);
        live.set(p, i & 255);
      }
      assert.equal(used(), 1024);
      assert.equal(allocate(base, 1, 1), 0);
      for (const [p] of [...live].filter((_, i) => i % 2 === 0)) {
        free(p);
        live.delete(p);
      }
      assert.equal(used(), 512);
      for (const [size, align] of [
        [0, 1],
        [129, 1],
        [1, 128],
        [1, 0],
        [1, 3],
        [-1, 1],
      ])
        assert.equal(allocate(base, size, align), 0);
      assert.equal(used(), 512);
      for (let i = 0; i < 512; i++) {
        const p = allocate(base, 96, 16);
        assert.ok(p >= base && p + 128 <= base + 131072 && p % 64 === 0);
        assert.equal(live.has(p), false);
        view.fill(42, p, p + 128);
        live.set(p, 42);
      }
      for (const [p, value] of live) {
        assert.ok(view.subarray(p, p + 128).every((b) => b === value));
        free(p);
      }
      assert.equal(used(), 0);
      // Deterministic mixed allocation/free history exercises partially occupied
      // scan groups and list links, while preserving every live payload.
      live.clear();
      let seed = 42;
      for (let step = 0; step < 12000; step++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        if (live.size && (seed >>> 24) & 1) {
          const p = [...live.keys()][(seed >>> 8) % live.size];
          assert.ok(view.subarray(p, p + 128).every((b) => b === live.get(p)));
          free(p);
          live.delete(p);
        } else {
          const p = allocate(base, 128, 64);
          if (p) {
            assert.equal(live.has(p), false);
            view.fill(step & 255, p, p + 128);
            live.set(p, step & 255);
          } else assert.equal(live.size, 1024);
        }
        assert.equal(used(), live.size);
      }
      for (const [p, value] of live) {
        assert.ok(view.subarray(p, p + 128).every((b) => b === value));
        free(p);
      }
      assert.equal(used(), 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
