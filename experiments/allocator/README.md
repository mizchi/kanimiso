# Allocator regression and performance fixtures

`just compare-allocator` compares current taraba-allocator with commit
`8cb75b788a4720753ac6fd30f64615f575e8761e` and wee_alloc 0.4.5. `prepare-allocator.mjs`
extracts that fixed reference into .cache and renames only its package, allowing
one locked workspace to build both implementations. A shallow checkout fetches
the fixed commit. No wasm-battleground checkout is required.

The common kernel and raw-pointer oracle originate in wasm-battleground's MIT
allocator experiments. The probe checks alignment, live payloads, zeroed/realloc,
all six three-block free orders, mixed/large-pair reuse plateaus, OOM recovery and
failed-realloc preservation. Each fresh instance has a 16 MiB maximum memory.
The ABI is trusted: freeing requires the exact live pointer, size and alignment.

wee_alloc fails the adjacent-block reuse oracle and is excluded from timing.
Current/reference variants must pass the full oracle before 9 kernels are timed.
The checked and normal kernel modes both pass an independent JS result oracle.
All timing uses V8's optimizing Wasm tier (`--no-liftoff`), at least 50 ms of
warmup per kernel/instance, 21 interleaved samples, batched Wasm calls,
and checks that timing never grows memory. This is a V8 microbenchmark, not a
Criterion confidence interval or Wasmtime benchmark. Small differences are noise.

Both std/no_std and size classes on/off are recorded, with and without the optional
`realloc_in_place` feature. The 25→28→25-byte `realloc_same_word` case targets that
fast path; it does not represent general Vec growth. The oracle also checks all
32 small classes across within-word and cross-class reallocations, and records
how often pointers stay in place without requiring that behavior from controls.
pair_32 requests 4-byte
alignment to exercise the small-class fast path on wasm32; the larger-alignment
cases exercise the main list. All variants use the same
Rust flags and Binaryen 133 optimization. The code-size regression guard requires
the small profile to be smaller than the fixed reference in both std modes.
The report includes the entire probe/kernel, not just allocator bytes. Application
results are measured separately in [the async size comparison](../../docs/async-size.ja.md).

MPL-2.0 allocator source and upstream provenance remain unchanged in license.
Miri and Kani apply to the current native test backend and selected boundaries;
they do not prove the whole allocator, engines, or emitted Wasm.
