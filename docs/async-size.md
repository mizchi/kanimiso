# Async library size comparison

English | [日本語](async-size.ja.md)

2026-10-19T15:58:19.683Z

Fresh builds of taraba, Embassy, wasm-bindgen-futures, Tokio, async-executor, async-std and FuturesUnordered. Every async build compiles the same two-await Rust source and passes 3,507 inputs, all I/O arguments and two externally controlled waits. These are dated application snapshots, not fixed library overhead or rankings for every workload.

## Compare std with the same allocator

All primary rows use taraba-allocator with size classes disabled, the same Rust/Binaryen, and identical final JS minification and Wasm optimization. Runtime distribution size is JS plus every required core Wasm.

| Backend | Sync total B | Async Wasm B | Async JS B | Async total B | Growth B | Brotli total B |
|---|---:|---:|---:|---:|---:|---:|
| taraba JSPI | 1,777 | 5,227 | 1,095 | 6,322 | +4,545 | 3,140 |
| taraba Future | 4,311 | 6,803 | 3,629 | 10,432 | +6,121 | 5,078 |
| Embassy WASM + JsFuture | 1,825 | 13,324 | 5,211 | 18,535 | +16,710 | 7,948 |
| wasm-bindgen-futures | 1,825 | 15,185 | 4,442 | 19,627 | +17,802 | 8,301 |
| Tokio current-thread + LocalSet | 1,825 | 52,689 | 4,442 | 57,131 | +55,306 | 22,389 |
| async-executor LocalExecutor | 1,825 | 32,288 | 4,442 | 36,730 | +34,905 | 15,181 |
| async-std spawn_local | 1,825 | 17,894 | 4,442 | 22,336 | +20,511 | 9,259 |
| FuturesUnordered task set | 1,825 | 18,459 | 4,440 | 22,899 | +21,074 | 9,591 |
| Component + jco | 53,104 | 25,314 | 66,776 | 92,090 | +38,986 | 27,100 |

With the same std/allocator, these differences are relative to Embassy. Negative values mean the taraba configuration is smaller.

| Backend | Async total − Embassy B | Ratio |
|---|---:|---:|
| taraba JSPI | -12,213 | 0.341× |
| taraba Future | -8,103 | 0.563× |
| wasm-bindgen-futures | +1,092 | 1.059× |
| Tokio current-thread + LocalSet | +38,596 | 3.082× |
| async-executor LocalExecutor | +18,195 | 1.982× |
| async-std spawn_local | +3,801 | 1.205× |
| FuturesUnordered task set | +4,364 | 1.235× |
| Component + jco | +73,555 | 4.968× |

## Added schedulers and growth above the shared bridge

The added profiles share wasm-bindgen-futures JsFuture and future_to_promise, then add their scheduler. Differences below use the wasm-bindgen-futures row with the same std/no_std and allocator, including bridge code and task/JoinHandle costs. They are not fixed library overhead.

| Backend | Mode | Extra Wasm B | Extra JS B | Extra total B |
|---|---|---:|---:|---:|
| Tokio current-thread + LocalSet | std | +37,504 | 0 | +37,504 |
| async-executor LocalExecutor | std | +17,103 | 0 | +17,103 |
| async-std spawn_local | std | +2,709 | 0 | +2,709 |
| FuturesUnordered task set | no_std | +2,300 | 0 | +2,300 |
| FuturesUnordered task set | std | +3,274 | -2 | +3,272 |

- **Tokio**: rt only, one current-thread Runtime and LocalSet per instance; spawn_local schedules compute and its JoinHandle is awaited. A custom JS adapter polls LocalSet once inside a block_on whose root immediately returns Ready on each wake. This avoids parking the JS thread; the next JS wake resumes it. The adapter is counted; timer/net/multithread are disabled. [WASM limits](https://docs.rs/tokio/latest/tokio/#wasm-support), [LocalSet](https://docs.rs/tokio/latest/tokio/task/struct.LocalSet.html).
- **async-executor**: one LocalExecutor per instance, with a persistent wasm-bindgen driver awaiting run(pending). The spawned compute Task is joined. This does not measure the full smol I/O reactor. [LocalExecutor](https://docs.rs/async-executor/latest/async_executor/struct.LocalExecutor.html).
- **async-std**: default features plus unstable spawn_local; the WASM implementation uses wasm-bindgen-futures and a channel JoinHandle. [API](https://docs.rs/async-std/latest/async_std/task/fn.spawn_local.html). The project is [discontinued](https://github.com/async-rs/async-std) and is included for existing-code comparisons.
- **FuturesUnordered**: a per-invocation collection containing one compute Future, awaited with StreamExt::next. It is a task-collection reference without an independent runtime or spawn API; its capabilities differ from a persistent executor. [API](https://docs.rs/futures-util/latest/futures_util/stream/struct.FuturesUnordered.html).

## no_std comparison

The selected official Embassy WASM platform, Tokio, async-executor and async-std configurations link std; no no_std values are invented. A raw no_std Embassy executor with a custom host is a different, unmeasured profile; see [Embassy cfg](https://docs.rs/crate/embassy-executor/0.10.0/source/src/lib.rs). FuturesUnordered is also measured as an alloc-based no_std task collection.

| Backend | Sync total B | Async Wasm B | Async JS B | Async total B | Growth B | Brotli total B |
|---|---:|---:|---:|---:|---:|---:|
| taraba JSPI | 1,203 | 248 | 1,095 | 1,343 | +140 | 748 |
| taraba Future | 3,737 | 1,712 | 3,629 | 5,341 | +1,604 | 2,726 |
| wasm-bindgen-futures | 1,244 | 9,783 | 4,442 | 14,225 | +12,981 | 6,057 |
| FuturesUnordered task set | 1,244 | 12,083 | 4,442 | 16,525 | +15,281 | 7,082 |
| Component + jco | 49,182 | 13,691 | 66,776 | 80,467 | +31,285 | 22,625 |

### Wasm added by std

This table isolates Wasm growth from linking std; any JS changes are counted separately in runtime totals. no_std traps on panic whereas std uses the standard panic path; the entire difference is not scheduler overhead.

| Backend | no_std async Wasm B | std async Wasm B | std − no_std B |
|---|---:|---:|---:|
| taraba JSPI | 248 | 5,227 | +4,979 |
| taraba Future | 1,712 | 6,803 | +5,091 |
| wasm-bindgen-futures | 9,783 | 15,185 | +5,402 |
| FuturesUnordered task set | 12,083 | 18,459 | +6,376 |
| Component + jco | 13,691 | 25,314 | +11,623 |

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
| wasm-bindgen-futures | no_std | 14,225 | 14,250 | +25 |
| wasm-bindgen-futures | std | 19,627 | 19,417 | -210 |
| Embassy WASM + JsFuture | std | 18,535 | 18,411 | -124 |

## npm and Component payloads

Declarations and the Component container are excluded from runtime download size. npm tarballs include those separate distribution payloads and gzip/package metadata. Shipping the Component as a separate entry packs both the container and its extracted cores.

| Backend / mode | Declarations B | Component B | npm tgz B |
|---|---:|---:|---:|
| taraba JSPI / no_std | 1,376 | 0 | 7,827 |
| taraba JSPI / std | 1,376 | 0 | 10,757 |
| taraba Future / no_std | 1,475 | 0 | 10,154 |
| taraba Future / std | 1,475 | 0 | 12,981 |
| Embassy WASM + JsFuture / std | 4,457 | 0 | 9,921 |
| wasm-bindgen-futures / no_std | 3,419 | 0 | 7,506 |
| wasm-bindgen-futures / std | 3,419 | 0 | 10,118 |
| Tokio current-thread + LocalSet / std | 3,419 | 0 | 26,611 |
| async-executor LocalExecutor / std | 3,419 | 0 | 18,187 |
| async-std spawn_local / std | 3,419 | 0 | 11,183 |
| FuturesUnordered task set / no_std | 3,419 | 0 | 8,632 |
| FuturesUnordered task set / std | 3,415 | 0 | 11,556 |
| Component + jco / no_std | 2,154 | 14,844 | 33,504 |
| Component + jco / std | 2,154 | 26,468 | 38,952 |

See the [usage guide](guide.md). Component provides WIT-typed async results; Core Future opaque Promise payloads remain unknown. The official wasm-bindgen declarations are retained and include any for this Rust-to-JS Promise result. Account for type information and API contracts when choosing.

## Verification and reproduction

Node v24.21.0 / V8 13.6.233.17-node.53; rustc 1.98.0 (88d9e12ae 2026-08-18); Binaryen 133; wasm-bindgen 0.2.129; wasm-bindgen-futures 0.4.79; js-sys 0.3.106; Embassy 0.10.0; Tokio 1.53.3; async-executor 1.14.0; async-std 1.13.2; futures-util 0.3.34; jco 1.39.0.

All 34 artifacts extracted from npm pack pass the same 3,507 cases and strict TypeScript. All 17 async artifacts also pass two externally controlled waits. Core JSPI serialization and independent progress in other backends are checked separately; added runtimes and Embassy are not assumed FIFO. Embassy admits 1,024 pending jobs, rejects only the 1,025th and then reuses its pool. Cancellation, Drop, fatal handling and JS object identity are not claimed equivalent.

The 11 wasm-bindgen-based async artifacts additionally check Promise rejection at each await, rejection-object identity, success of an independent task, and subsequent executor reuse. JSPI/Core Future/Component error contracts are separate.

No performance ranking is measured here. Execution uses V8; Safari hardware, native Component hosts, JS heap and suspended-stack memory are unmeasured. no_std rows disable std features and define the application panic handler. The official Embassy WASM platform's required std is explicitly separate.

```sh
just compare-async-size  # rebuild, verify, write this snapshot
just check-async-size    # same verification, .cache output only
```

Per-file raw/gzip/Brotli, separate Wasm/JS growth, and input SHA hashes are in [JSON](async-size.json). No pre-extraction measurements are reused.
