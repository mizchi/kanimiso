# Rich async comparison

English | [日本語](rich-async-size.ja.md)

Both backends run the same WIT record/string/list<u8>/result workload and the exact same [Rust workflow](../experiments/rich-async/src/workflow.rs): two async host transforms, string appends and wrapping byte arithmetic. Standard wit-bindgen uses the Component Canonical ABI plus jco; taraba uses its private Core Promise ABI.

Measured 2026-10-21 on Node v24.21.0 / V8 13.6.233.17-node.53, Apple M5. This is not a Safari browser or Wasmtime/WASI measurement.

## Deployed size

| Backend | Rust | Wasm | JS | Total |
|---|---|---:|---:|---:|
| taraba | no_std | 4,280 B | 4,449 B | 8,729 B |
| wit-bindgen | no_std | 13,202 B | 83,310 B | 96,512 B |
| taraba | std | 8,415 B | 4,449 B | 12,864 B |
| wit-bindgen | std | 23,727 B | 83,310 B | 107,037 B |

Both use wasm-opt -Oz, Rust LTO, one codegen unit, panic=abort and the same taraba-allocator with default features disabled. Rolldown produces one minified ESM. wit-bindgen 0.58.0 enables macros/async without async-spawn; all deployed jco 1.39.0 Core Wasm and JS are counted. Component containers and declarations are excluded from the runtime total to avoid double counting. taraba JS includes the shared runtime.

## Execution time

Median microseconds per call in non-instrumented release artifacts. Thirty warmup batches, seven samples of twenty batches, identical host Promise microtasks, Node --no-liftoff. Concurrency16 divides batch duration by calls; it is throughput time per call, not request latency.

| Backend | Rust | 32 B / concurrency1 | 32 B / concurrency16 | 1 KiB / concurrency1 | 1 KiB / concurrency16 |
|---|---|---:|---:|---:|---:|
| taraba | no_std | 11.87 µs | 7.44 µs | 162.70 µs | 62.22 µs |
| wit-bindgen | no_std | 2591.26 µs | 2453.70 µs | 2940.86 µs | 2765.48 µs |
| taraba | std | 10.69 µs | 6.96 µs | 61.48 µs | 62.03 µs |
| wit-bindgen | std | 2441.38 µs | 2455.37 µs | 2918.15 µs | 2852.20 µs |

These observations apply to this engine, version and workload. They include the Canonical async scheduler versus Core microtask scheduling contracts; they are not a general Rust Future versus JSPI result. JSON also records sample minima and maxima.

## Memory

Separate binaries use the identical counting allocator wrapper; instrumentation is excluded from size and timing. The table shows the last batch in a sequence ending with 1 KiB payloads × concurrency128. Four timer/immediate turns before and after each batch allow deferred post-return work to run.

| Backend | Rust | Initial linear memory | Peak requested Rust heap | Requested heap after completion | Linear memory high-water mark |
|---|---|---:|---:|---:|---:|
| taraba | no_std | 262,144 B | 133,007 B | 0 B | 458,752 B |
| wit-bindgen | no_std | 131,072 B | 305,285 B | 302,806 B | 589,824 B |
| taraba | std | 262,144 B | 133,007 B | 0 B | 458,752 B |
| wit-bindgen | std | 131,072 B | 305,285 B | 302,806 B | 589,824 B |

Requested heap counts Layout.size() and excludes allocator metadata, fragmentation, JS heap and static task storage. Linear memory includes static data, stack and reserved pages. taraba's 1,024×128 B static pool increases its initial linear memory. Neither metric is whole-process memory use.

This wit-bindgen/jco configuration retains requested heap after Promise completion and event-loop turns. An isolated repeated-call probe also retains bytes; outputs do not share guest memory, and no new_size=0 cabi_realloc calls were observed. This narrows investigation to cleanup at generated glue value boundaries, but the exact allocation site is not established. This observation does not establish a general Component memory leak or efficiency claim. Per-batch before/after counters are recorded in JSON.

## Reproduction and verification

Run `just compare-rich-async` to update JSON and both language tables. Each normal and instrumented build passes the same 216 cases covering Unicode, empty strings/arrays, 64 KiB, u32 wrapping, domain errors, input copies, concurrency and reuse after errors.

[JSON](rich-async-size.json) · [WIT](../experiments/rich-async/wit/app.wit) · [Shared tests](../experiments/rich-async/contract.mjs) · [Measurement runner](../tools/compare-rich-async.mjs)
