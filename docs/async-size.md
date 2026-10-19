# Async library size comparison

English | [日本語](async-size.ja.md)

2026-10-19T04:15:20.692Z

Fresh builds of taraba, Embassy, wasm-bindgen-futures, Tokio, async-executor, async-std and FuturesUnordered. Every async build compiles the same two-await Rust source and passes 3,507 inputs, all I/O arguments and two externally controlled waits. These are dated application snapshots, not fixed library overhead or rankings for every workload.

## Compare std with the same allocator

All primary rows use taraba-allocator with size classes disabled, the same Rust/Binaryen, and identical final JS minification and Wasm optimization. Runtime distribution size is JS plus every required core Wasm.

| Backend | Sync total B | Async Wasm B | Async JS B | Async total B | Growth B | Brotli total B |
|---|---:|---:|---:|---:|---:|---:|
| taraba JSPI | 2,120 | 5,263 | 1,402 | 6,665 | +4,545 | 3,165 |
| taraba Future | 4,725 | 6,871 | 4,007 | 10,878 | +6,153 | 5,219 |
| Embassy WASM + JsFuture | 1,861 | 13,360 | 5,211 | 18,571 | +16,710 | 7,950 |
| wasm-bindgen-futures | 1,861 | 15,221 | 4,442 | 19,663 | +17,802 | 8,334 |
| Tokio current-thread + LocalSet | 1,861 | 52,721 | 4,442 | 57,163 | +55,302 | 22,384 |
| async-executor LocalExecutor | 1,861 | 32,324 | 4,442 | 36,766 | +34,905 | 15,196 |
| async-std spawn_local | 1,861 | 17,930 | 4,442 | 22,372 | +20,511 | 9,245 |
| FuturesUnordered task set | 1,861 | 18,495 | 4,440 | 22,935 | +21,074 | 9,589 |
| Component + jco | 53,140 | 25,350 | 66,776 | 92,126 | +38,986 | 27,091 |

With the same std/allocator, these differences are relative to Embassy. Negative values mean the taraba configuration is smaller.

| Backend | Async total − Embassy B | Ratio |
|---|---:|---:|
| taraba JSPI | -11,906 | 0.359× |
| taraba Future | -7,693 | 0.586× |
| wasm-bindgen-futures | +1,092 | 1.059× |
| Tokio current-thread + LocalSet | +38,592 | 3.078× |
| async-executor LocalExecutor | +18,195 | 1.980× |
| async-std spawn_local | +3,801 | 1.205× |
| FuturesUnordered task set | +4,364 | 1.235× |
| Component + jco | +73,555 | 4.961× |

## Added schedulers and growth above the shared bridge

The added profiles share wasm-bindgen-futures JsFuture and future_to_promise, then add their scheduler. Differences below use the wasm-bindgen-futures row with the same std/no_std and allocator, including bridge code and task/JoinHandle costs. They are not fixed library overhead.

| Backend | Mode | Extra Wasm B | Extra JS B | Extra total B |
|---|---|---:|---:|---:|
| Tokio current-thread + LocalSet | std | +37,500 | 0 | +37,500 |
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
| taraba JSPI | 1,510 | 248 | 1,402 | 1,650 | +140 | 773 |
| taraba Future | 4,115 | 1,744 | 4,007 | 5,751 | +1,636 | 2,840 |
| wasm-bindgen-futures | 1,244 | 9,783 | 4,442 | 14,225 | +12,981 | 6,057 |
| FuturesUnordered task set | 1,244 | 12,083 | 4,442 | 16,525 | +15,281 | 7,082 |
| Component + jco | 49,182 | 13,691 | 66,776 | 80,467 | +31,285 | 22,625 |

### Wasm added by std

This table isolates Wasm growth from linking std; any JS changes are counted separately in runtime totals. no_std traps on panic whereas std uses the standard panic path; the entire difference is not scheduler overhead.

| Backend | no_std async Wasm B | std async Wasm B | std − no_std B |
|---|---:|---:|---:|
| taraba JSPI | 248 | 5,263 | +5,015 |
| taraba Future | 1,744 | 6,871 | +5,127 |
| wasm-bindgen-futures | 9,783 | 15,221 | +5,438 |
| FuturesUnordered task set | 12,083 | 18,495 | +6,412 |
| Component + jco | 13,691 | 25,350 | +11,659 |

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
| wasm-bindgen-futures | std | 19,663 | 19,417 | -246 |
| Embassy WASM + JsFuture | std | 18,571 | 18,411 | -160 |

## npm and Component payloads

Declarations and the Component container are excluded from runtime download size. npm tarballs include those separate distribution payloads and gzip/package metadata. Shipping the Component as a separate entry packs both the container and its extracted cores.

| Backend / mode | Declarations B | Component B | npm tgz B |
|---|---:|---:|---:|
| taraba JSPI / no_std | 1,340 | 0 | 2,462 |
| taraba JSPI / std | 1,340 | 0 | 5,271 |
| taraba Future / no_std | 2,082 | 0 | 5,033 |
| taraba Future / std | 2,082 | 0 | 7,813 |
| Embassy WASM + JsFuture / std | 4,457 | 0 | 9,946 |
| wasm-bindgen-futures / no_std | 3,419 | 0 | 7,506 |
| wasm-bindgen-futures / std | 3,419 | 0 | 10,156 |
| Tokio current-thread + LocalSet / std | 3,419 | 0 | 26,616 |
| async-executor LocalExecutor / std | 3,419 | 0 | 18,215 |
| async-std spawn_local / std | 3,419 | 0 | 11,205 |
| FuturesUnordered task set / no_std | 3,419 | 0 | 8,632 |
| FuturesUnordered task set / std | 3,415 | 0 | 11,585 |
| Component + jco / no_std | 2,154 | 14,844 | 28,744 |
| Component + jco / std | 2,154 | 26,504 | 34,298 |

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
