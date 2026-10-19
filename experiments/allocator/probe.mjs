import assert from "node:assert/strict";
export async function verifyAllocator(factory) {
  let allocations = 0,
    checkedBytes = 0;
  const make = async () => {
    const e = await factory(),
      live = [];
    const view = () => new Uint8Array(e.memory.buffer);
    const validate = (p, size, align) => {
      assert.ok(p !== 0, "allocation failed");
      assert.equal(p % align, 0, "alignment");
      assert.ok(p + size <= e.memory.buffer.byteLength, "allocation bounds");
      for (const b of live)
        assert.ok(
          p + size <= b.p || b.p + b.size <= p,
          "overlapping live allocations",
        );
    };
    const alloc = (size, align = 8, pattern = 123, zeroed = false) => {
      const p =
        (zeroed ? e.mem_zeroed(size, align) : e.mem_alloc(size, align)) >>> 0;
      validate(p, size, align);
      const v = view();
      if (zeroed)
        for (let i = 0; i < size; i++)
          assert.equal(v[p + i], 0, "alloc_zeroed");
      for (let i = 0; i < size; i++) v[p + i] = (pattern + i * 17) & 255;
      const b = { p, size, align, pattern };
      live.push(b);
      allocations++;
      return b;
    };
    const check = (b) => {
      const v = view();
      for (let i = 0; i < b.size; i++)
        assert.equal(v[b.p + i], (b.pattern + i * 17) & 255, "live payload");
      checkedBytes += b.size;
    };
    const free = (b) => {
      check(b);
      e.mem_free(b.p, b.size, b.align);
      live.splice(live.indexOf(b), 1);
    };
    const realloc = (b, size) => {
      check(b);
      const p = e.mem_realloc(b.p, b.size, b.align, size) >>> 0;
      assert.ok(p !== 0, "realloc failed");
      live.splice(live.indexOf(b), 1);
      validate(p, size, b.align);
      const v = view();
      for (let i = 0; i < Math.min(size, b.size); i++)
        assert.equal(v[p + i], (b.pattern + i * 17) & 255, "realloc prefix");
      for (let i = 0; i < size; i++) v[p + i] = (b.pattern + i * 17) & 255;
      Object.assign(b, { p, size });
      live.push(b);
    };
    return { e, live, alloc, check, free, realloc };
  };
  // Two live regions first: the host must catch overlap before writing the second.
  let h = await make();
  // The trusted ABI rejects zero requests before invoking GlobalAlloc.
  assert.equal(h.e.mem_alloc(0, 8), 0);
  assert.equal(h.e.mem_zeroed(0, 8), 0);
  assert.equal(h.e.mem_realloc(0, 8, 8, 16), 0);
  h.e.mem_free(0, 0, 0);
  const first = h.alloc(64),
    second = h.alloc(64);
  assert.equal(h.e.mem_realloc(first.p, first.size, first.align, 0), 0);
  h.check(first);
  h.free(first);
  h.free(second);
  for (const align of [1, 2, 4, 8, 16, 64, 256, 4096, 65536])
    for (const size of [1, 3, 17, 129, 2049]) {
      const b = h.alloc(size, align, 37, true);
      h.realloc(b, size * 2 + 7);
      h.realloc(b, size);
      h.free(b);
    }
  h = await make();
  let stationary = 0;
  for (let words = 1; words <= 32; words++) {
    const b = h.alloc(words * 4 - 3, 4, words);
    for (const size of [words * 4, words * 4 - 3, words * 4 + 1, 1]) {
      const address = b.p;
      h.realloc(b, size);
      if (b.p === address) stationary++;
    }
    h.free(b);
  }
  const merge = [];
  for (const order of [
    [0, 1, 2],
    [2, 1, 0],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
  ]) {
    h = await make();
    const blocks = Array.from({ length: 3 }, () => h.alloc(20000));
    const before = h.e.memory.buffer.byteLength;
    for (const index of order) h.free(blocks[index]);
    const joined = h.alloc(60000);
    assert.equal(
      h.e.memory.buffer.byteLength,
      before,
      "adjacent free blocks must be reusable",
    );
    h.free(joined);
    merge.push({ order, bytes: before });
  }
  h = await make();
  const mixedPages = [];
  for (let batch = 0; batch < 12; batch++) {
    let seed = 0x12345678;
    const slots = Array(48).fill(null);
    for (let step = 0; step < 512; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const index = (seed >>> 16) % slots.length;
      if (slots[index]) {
        h.free(slots[index]);
        slots[index] = null;
      } else {
        const sizes = [8, 16, 24, 32, 64, 96, 128, 256, 1024, 4096, 16384];
        slots[index] = h.alloc(
          sizes[seed % sizes.length] + ((seed >>> 8) & 3),
          1 << ((seed >>> 24) % 9),
          seed & 255,
        );
      }
    }
    for (const b of slots.filter(Boolean)) h.free(b);
    mixedPages.push(h.e.memory.buffer.byteLength / 65536);
  }
  assert.equal(
    mixedPages.at(-1),
    mixedPages[5],
    "fixed mixed workload must reach a reuse plateau",
  );
  const pairs = [];
  for (const sizes of [
    [85196, 80000],
    [8190, 8191],
    [8192, 8188],
    [16281, 100],
  ]) {
    h = await make();
    const pages = [];
    for (let i = 0; i < 64; i++) {
      const a = h.alloc(sizes[0], 8, 1),
        b = h.alloc(sizes[1], 8, 2);
      h.free(a);
      h.free(b);
      pages.push(h.e.memory.buffer.byteLength / 65536);
    }
    assert.equal(pages.at(-1), pages[7], "large-pair reuse plateau");
    pairs.push({ sizes, warm_pages: pages[7], final_pages: pages.at(-1) });
  }
  // Exhaust a 16 MiB instance using valid layouts; null must preserve live allocations.
  h = await make();
  const blocks = [];
  const size = 1024 * 1024;
  for (let i = 0; i < 32; i++) {
    const p = h.e.mem_alloc(size, 16) >>> 0;
    if (!p) break;
    assert.equal(p % 16, 0);
    assert.ok(p + size <= h.e.memory.buffer.byteLength);
    for (const b of blocks)
      assert.ok(p + size <= b || b + size <= p, "OOM overlap");
    new Uint8Array(h.e.memory.buffer)[p] = i;
    blocks.push(p);
  }
  assert.ok(blocks.length > 0 && blocks.length < 32, "bounded OOM reached");
  for (let i = 0; i < blocks.length; i++)
    assert.equal(new Uint8Array(h.e.memory.buffer)[blocks[i]], i);
  const oomBytes = h.e.memory.buffer.byteLength;
  assert.equal(
    h.e.mem_alloc(0x7fffff00, 256),
    0,
    "huge valid request must fail",
  );
  assert.equal(
    h.e.memory.buffer.byteLength,
    oomBytes,
    "failed request must not grow memory",
  );
  const old = blocks[0];
  assert.equal(h.e.mem_realloc(old, size, 16, 0x7fffff00), 0);
  assert.equal(
    new Uint8Array(h.e.memory.buffer)[old],
    0,
    "failed realloc preserves old value",
  );
  for (const p of blocks) h.e.mem_free(p, size, 16);
  const reused = [];
  for (let i = 0; i < blocks.length; i++) {
    const p = h.e.mem_alloc(size, 16) >>> 0;
    assert.ok(p, "OOM recovery reuses freed space");
    reused.push(p);
  }
  for (const p of reused) h.e.mem_free(p, size, 16);
  return {
    all_passed: true,
    allocations,
    checked_bytes: checkedBytes,
    realloc_word_roundtrips: { calls: 128, stationary },
    merge,
    mixed_pages: mixedPages,
    pairs,
    oom: { bytes: oomBytes, blocks: blocks.length, recovered: reused.length },
  };
}
