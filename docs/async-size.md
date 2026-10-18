# Async library size comparison

English | [日本語](async-size.ja.md)

2026-10-18T19:35:12.500Z

Fresh builds of current taraba, the official Embassy WASM executor and wasm-bindgen-futures. Every async build compiles the same two-await Rust source and passes 3,507 inputs, all I/O arguments and two externally controlled waits. These are dated application snapshots, not fixed library overhead or rankings for every workload.

## Compare std with the same allocator

All primary rows use taraba-allocator with size classes disabled, the same Rust/Binaryen, and identical final JS minification and Wasm optimization. Runtime distribution size is JS plus every required core Wasm.

| Backend | Sync total B | Async Wasm B | Async JS B | Async total B | Growth B | Brotli total B |
|---|---:|---:|---:|---:|---:|---:|
| taraba JSPI | 2,277 | 5,635 | 1,431 | 7,066 | +4,789 | 3,329 |
| taraba Future | 4,853 | 7,238 | 4,007 | 11,245 | +6,392 | 5,324 |
| Component + jco | 53,514 | 25,800 | 66,776 | 92,576 | +39,062 | 27,244 |
| wasm-bindgen-futures | 1,986 | 15,620 | 4,442 | 20,062 | +18,076 | 8,461 |
| Embassy WASM + JsFuture | 1,986 | 13,844 | 5,211 | 19,055 | +17,069 | 8,084 |

With the same std/allocator, these differences are relative to Embassy. Negative values mean the taraba configuration is smaller.

| Backend | Async total − Embassy B | Ratio |
|---|---:|---:|
| taraba JSPI | -11,989 | 0.371× |
| taraba Future | -7,810 | 0.590× |
| Component + jco | +73,521 | 4.858× |
| wasm-bindgen-futures | +1,007 | 1.053× |

## no_std comparison

Embassy 0.10.0 platform-wasm links std, so no no_std value is invented for it. A no_std raw Embassy executor with a custom host is a different, unmeasured configuration here; see [upstream cfg](https://docs.rs/crate/embassy-executor/0.10.0/source/src/lib.rs). Do not attribute std/no_std differences solely to the executor.

| Backend | Sync total B | Async Wasm B | Async JS B | Async total B | Growth B | Brotli total B |
|---|---:|---:|---:|---:|---:|---:|
| taraba JSPI | 1,539 | 248 | 1,431 | 1,679 | +140 | 785 |
| taraba Future | 4,115 | 1,744 | 4,007 | 5,751 | +1,636 | 2,840 |
| Component + jco | 49,544 | 14,102 | 66,776 | 80,878 | +31,334 | 22,788 |
| wasm-bindgen-futures | 1,244 | 10,171 | 4,442 | 14,613 | +13,369 | 6,217 |

### Wasm added by std

JS bytes stay equal, while linking std increases Wasm. no_std traps on panic whereas std uses the standard panic path; the entire difference is not scheduler overhead.

| Backend | no_std async Wasm B | std async Wasm B | std − no_std B |
|---|---:|---:|---:|
| taraba JSPI | 248 | 5,635 | +5,387 |
| taraba Future | 1,744 | 7,238 | +5,494 |
| Component + jco | 14,102 | 25,800 | +11,698 |
| wasm-bindgen-futures | 10,171 | 15,620 | +5,449 |

## Interpret the growth correctly

The sync control performs add(a,b), then add(first,1), in the same order. Each backend's public JS API is included, so prelinked fixed costs already appear in its sync control. This is not the entire cost of adding all async capabilities to bare WebAssembly.

- JSPI uses the same Promise host in both controls. The Rust Future suspends inside the host import and returns Ready from poll. JS bytes stay equal here, while the difference between a direct function and Rust Future code generation remains in Wasm. Engine implementation and suspended-stack memory are outside transmitted bytes.
- taraba Future's synchronous control already includes the existing host. Incremental async bytes and fixed host bytes are different.
- Component includes typed WIT async, Canonical ABI and the jco scheduler. This scalar workload does not exercise records or its other general types.
- Embassy uses the official WASM event-loop integration, JsFuture and 1,024 statically allocated typed workers. Reserved pool memory differs from transmitted Wasm bytes; this is not the same API as dynamically spawning arbitrary-size Futures.

## Allocator control: wee_alloc

Only the following control switches the allocator to wee_alloc 0.4.5; size classes are disabled in both. Differences include allocator/caller optimization, not a different executor.

| Backend | Mode | taraba-allocator total B | wee_alloc total B | wee − taraba B |
|---|---|---:|---:|---:|
| wasm-bindgen-futures | no_std | 14,613 | 14,250 | -363 |
| wasm-bindgen-futures | std | 20,062 | 19,417 | -645 |
| Embassy WASM + JsFuture | std | 19,055 | 18,411 | -644 |

## npm and Component payloads

Declarations and the Component container are excluded from runtime download size. npm tarballs include those separate distribution payloads and gzip/package metadata. Shipping the Component as a separate entry packs both the container and its extracted cores.

| Backend / mode | Declarations B | Component B | npm tgz B |
|---|---:|---:|---:|
| taraba JSPI / no_std | 1,340 | 0 | 2,473 |
| taraba JSPI / std | 1,340 | 0 | 5,442 |
| taraba Future / no_std | 2,082 | 0 | 5,033 |
| taraba Future / std | 2,082 | 0 | 8,008 |
| Component + jco / no_std | 2,154 | 15,255 | 28,940 |
| Component + jco / std | 2,154 | 26,954 | 34,455 |
| wasm-bindgen-futures / no_std | 3,419 | 0 | 7,667 |
| wasm-bindgen-futures / std | 3,419 | 0 | 10,300 |
| Embassy WASM + JsFuture / std | 4,457 | 0 | 10,126 |

See the [usage guide](guide.md). Component provides WIT-typed async results; Core Future opaque Promise payloads remain unknown. The official wasm-bindgen declarations are retained and include any for this Rust-to-JS Promise result. Account for type information and API contracts when choosing.

## Verification and reproduction

Node v24.21.0 / V8 13.6.233.17-node.53; rustc 1.98.0 (88d9e12ae 2026-08-18); Binaryen 133; wasm-bindgen 0.2.129; wasm-bindgen-futures 0.4.79; js-sys 0.3.106; Embassy 0.10.0; jco 1.39.0.

All 24 artifacts extracted from npm pack pass the same 3,507 cases and strict TypeScript. All 12 async artifacts also pass two externally controlled waits. Core JSPI serialization and independent task progress in Future/wasm-bindgen/Embassy are checked separately; Embassy startup is not assumed FIFO. Embassy admits 1,024 pending jobs, rejects only the 1,025th and then reuses its pool. Cancellation, Drop, fatal handling and JS object identity are not claimed equivalent.

No performance ranking is measured here. Execution uses V8; Safari hardware, native Component hosts, JS heap and suspended-stack memory are unmeasured. no_std rows disable std features and define the application panic handler. The official Embassy WASM platform's required std is explicitly separate.

```sh
just compare-async-size  # rebuild, verify, write this snapshot
just check-async-size    # same verification, .cache output only
```

Per-file raw/gzip/Brotli, separate Wasm/JS growth, and input SHA hashes are in [JSON](async-size.json). No pre-extraction measurements are reused.
