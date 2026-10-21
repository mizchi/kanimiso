# Async library size comparison

English | [日本語](async-size.ja.md)

2026-10-21T07:58:43.659Z

Fresh builds of taraba, Embassy, wasm-bindgen-futures, wit-bindgen, Tokio, async-executor, async-std and FuturesUnordered. Every async build compiles the same two-await Rust source and passes 3,507 inputs, all I/O arguments and two externally controlled waits. These are dated application snapshots, not fixed library overhead or rankings for every workload.

## Compare std with the same allocator

All primary rows use taraba-allocator with size classes disabled, the same Rust/Binaryen, and identical final JS minification and Wasm optimization. Runtime distribution size is JS plus every required core Wasm.

| Backend | Sync total B | Async Wasm B | Async JS B | Async total B | Growth B | Brotli total B |
|---|---:|---:|---:|---:|---:|---:|
| taraba JSPI | 1,891 | 5,227 | 1,209 | 6,436 | +4,545 | 3,175 |
| taraba Future (manual ABI) | 4,377 | 6,807 | 3,695 | 10,502 | +6,125 | 5,130 |
| taraba Future | 4,377 | 6,640 | 3,695 | 10,335 | +5,958 | 5,039 |
| Embassy WASM + JsFuture | 1,867 | 13,324 | 5,242 | 18,566 | +16,699 | 7,945 |
| wasm-bindgen-futures | 1,867 | 15,185 | 4,478 | 19,663 | +17,796 | 8,310 |
| Tokio current-thread + LocalSet | 1,867 | 52,689 | 4,478 | 57,167 | +55,300 | 22,398 |
| async-executor LocalExecutor | 1,867 | 32,288 | 4,478 | 36,766 | +34,899 | 15,190 |
| async-std spawn_local | 1,867 | 17,894 | 4,478 | 22,372 | +20,505 | 9,267 |
| FuturesUnordered task set | 1,867 | 18,459 | 4,476 | 22,935 | +21,068 | 9,600 |
| wit-bindgen async + jco | 53,179 | 21,871 | 66,825 | 88,696 | +35,517 | 25,496 |
| wit-bindgen async-spawn + jco | 53,179 | 25,314 | 66,825 | 92,139 | +38,960 | 26,789 |

## Rust Futures: taraba and wit-bindgen

Both drive the same Rust Future. wit-bindgen uses WIT async func and the standard Canonical ABI; taraba Future uses typed bindings generated from WIT future<s32>, internally mapped to JS Promises and a private resource ABI. The minimal wit-bindgen configuration enables only macros/async. A separate async-spawn control retains its internal FuturesUnordered support. The wit-bindgen workload uses async func rather than explicit future<T> value transfers or spawn operations.

| Rust | wit-bindgen Wasm B | taraba Future Wasm B | Wasm reduction | wit-bindgen Wasm + JS B | taraba Future Wasm + JS B |
|---|---:|---:|---:|---:|---:|
| std | 21,871 | 6,640 | 69.6% | 88,696 | 10,335 |
| no_std | 11,236 | 1,575 | 86.0% | 78,061 | 5,270 |

Totals include the jco JavaScript and every core Wasm required to execute the wit-bindgen Component in JavaScript, without counting the Component container twice. Standard Canonical async ABI and the private Core Promise ABI have different capabilities; the full difference is not solely Rust executor savings.

## Cost of typed Core async bindings

Both versions drive the same compute Future with the same allocator and optimization settings. The control manually converts Promise handles; the typed version generates safe imports/Guest from WIT. Public WIT metadata is validated and stripped during the build. This is not an implementation of standard Component future ABI.

| Rust | Manual Wasm B | Typed Wasm B | Wasm growth B | Manual JS B | Typed JS B | JS growth B |
|---|---:|---:|---:|---:|---:|---:|---:|
| std | 6,807 | 6,640 | -167 | 3,695 | 3,695 | 0 |
| no_std | 1,716 | 1,575 | -141 | 3,695 | 3,695 | 0 |

With the same std/allocator, these differences are relative to Embassy. Negative values mean the taraba configuration is smaller.

| Backend | Async total − Embassy B | Ratio |
|---|---:|---:|
| taraba JSPI | -12,130 | 0.347× |
| taraba Future (manual ABI) | -8,064 | 0.566× |
| taraba Future | -8,231 | 0.557× |
| wasm-bindgen-futures | +1,097 | 1.059× |
| Tokio current-thread + LocalSet | +38,601 | 3.079× |
| async-executor LocalExecutor | +18,200 | 1.980× |
| async-std spawn_local | +3,806 | 1.205× |
| FuturesUnordered task set | +4,369 | 1.235× |
| wit-bindgen async + jco | +70,130 | 4.777× |
| wit-bindgen async-spawn + jco | +73,573 | 4.963× |

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
| taraba JSPI | 1,317 | 248 | 1,209 | 1,457 | +140 | 783 |
| taraba Future (manual ABI) | 3,803 | 1,716 | 3,695 | 5,411 | +1,608 | 2,740 |
| taraba Future | 3,803 | 1,575 | 3,695 | 5,270 | +1,467 | 2,666 |
| wasm-bindgen-futures | 1,286 | 9,783 | 4,478 | 14,261 | +12,975 | 6,063 |
| FuturesUnordered task set | 1,286 | 12,083 | 4,478 | 16,561 | +15,275 | 7,088 |
| wit-bindgen async + jco | 49,257 | 11,236 | 66,825 | 78,061 | +28,804 | 21,295 |
| wit-bindgen async-spawn + jco | 49,257 | 13,691 | 66,825 | 80,516 | +31,259 | 22,302 |

### Wasm added by std

This table isolates Wasm growth from linking std; any JS changes are counted separately in runtime totals. no_std traps on panic whereas std uses the standard panic path; the entire difference is not scheduler overhead.

| Backend | no_std async Wasm B | std async Wasm B | std − no_std B |
|---|---:|---:|---:|
| taraba JSPI | 248 | 5,227 | +4,979 |
| taraba Future (manual ABI) | 1,716 | 6,807 | +5,091 |
| taraba Future | 1,575 | 6,640 | +5,065 |
| wasm-bindgen-futures | 9,783 | 15,185 | +5,402 |
| FuturesUnordered task set | 12,083 | 18,459 | +6,376 |
| wit-bindgen async + jco | 11,236 | 21,871 | +10,635 |
| wit-bindgen async-spawn + jco | 13,691 | 25,314 | +11,623 |

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
| wasm-bindgen-futures | no_std | 14,261 | 14,286 | +25 |
| wasm-bindgen-futures | std | 19,663 | 19,453 | -210 |
| Embassy WASM + JsFuture | std | 18,566 | 18,442 | -124 |

## npm and Component payloads

Declarations and the Component container are excluded from runtime download size. npm tarballs include those separate distribution payloads and gzip/package metadata. Shipping the Component as a separate entry packs both the container and its extracted cores.

| Backend / mode | Declarations B | Component B | npm tgz B |
|---|---:|---:|---:|
| taraba JSPI / no_std | 1,412 | 0 | 7,890 |
| taraba JSPI / std | 1,412 | 0 | 10,826 |
| taraba Future (manual ABI) / no_std | 1,511 | 0 | 10,221 |
| taraba Future (manual ABI) / std | 1,511 | 0 | 13,055 |
| taraba Future / no_std | 1,531 | 0 | 10,147 |
| taraba Future / std | 1,531 | 0 | 12,964 |
| Embassy WASM + JsFuture / std | 4,457 | 0 | 9,906 |
| wasm-bindgen-futures / no_std | 3,419 | 0 | 7,525 |
| wasm-bindgen-futures / std | 3,419 | 0 | 10,139 |
| Tokio current-thread + LocalSet / std | 3,419 | 0 | 26,633 |
| async-executor LocalExecutor / std | 3,419 | 0 | 18,206 |
| async-std spawn_local / std | 3,419 | 0 | 11,206 |
| FuturesUnordered task set / no_std | 3,419 | 0 | 8,652 |
| FuturesUnordered task set / std | 3,415 | 0 | 11,571 |
| wit-bindgen async + jco / no_std | 2,154 | 12,389 | 31,895 |
| wit-bindgen async + jco / std | 2,154 | 23,025 | 37,016 |
| wit-bindgen async-spawn + jco / no_std | 2,154 | 14,844 | 33,047 |
| wit-bindgen async-spawn + jco / std | 2,154 | 26,468 | 38,505 |

See the [usage guide](guide.md). Typed Core Future generates Promise<number> from WIT future<s32>; legacy opaque resources remain unknown. Component uses the standard typed async ABI. The official wasm-bindgen declarations are retained and include any for this Rust-to-JS Promise result.

## Verification and reproduction

Node v24.21.0 / V8 13.6.233.17-node.53; rustc 1.98.0 (88d9e12ae 2026-08-18); Binaryen 133; wasm-bindgen 0.2.129; wasm-bindgen-futures 0.4.79; js-sys 0.3.106; wit-bindgen 0.58.0; Embassy 0.10.0; Tokio 1.53.3; async-executor 1.14.0; async-std 1.13.2; futures-util 0.3.34; jco 1.39.0; Rolldown 1.2.14.

All 42 artifacts extracted from npm pack pass the same 3,507 cases and strict TypeScript. All 21 async artifacts also pass two externally controlled waits. Core JSPI serialization and independent progress in other backends are checked separately; added runtimes and Embassy are not assumed FIFO. Embassy admits 1,024 pending jobs, rejects only the 1,025th and then reuses its pool. Cancellation, Drop, fatal handling and JS object identity are not claimed equivalent.

The 11 wasm-bindgen-based async artifacts additionally check Promise rejection at each await, rejection-object identity, success of an independent task, and subsequent executor reuse. JSPI/Core Future/Component error contracts are separate.

No performance ranking is measured here. Execution uses V8; Safari hardware, native Component hosts, JS heap and suspended-stack memory are unmeasured. no_std rows disable std features and define the application panic handler. The official Embassy WASM platform's required std is explicitly separate.

```sh
just compare-async-size  # rebuild, verify, write this snapshot
just check-async-size    # same verification, .cache output only
```

Per-file raw/gzip/Brotli, separate Wasm/JS growth, and input SHA hashes are in [JSON](async-size.json). No pre-extraction measurements are reused.
