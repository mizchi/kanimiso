# Current capabilities and limits

English | [日本語](status.ja.md)

This page describes 0.2.1, including resource instance methods and Rust-defined exported resources. When upgrading from 0.1.0, update both the CLI and Rust crate dependencies, then regenerate `pkg/`. See the [installation guide](guide.md#installation).

## Choosing an execution contract

| Requirement | Core/JSPI | Core Future | Component |
|---|---|---|---|
| Small numeric boundary | Default; s32/u32/f64/void | Supported | Supported |
| WIT strings, records, lists and other value types | Unsupported | Sync and async; world and interface functions | Standard wit-bindgen bindings |
| Rust `.await`, independent tasks, `spawn_local` | No Future executor; JSPI suspends synchronous guest calls | Supported | Component toolchain's async implementation |
| Imported opaque resource own/borrow in async functions | Unsupported | Freestanding functions supported | Standard resource bindings |
| Imported resource constructors | Unsupported | Typed factory per interface alias | Standard resource bindings |
| Resource instance methods / Rust-defined exported resources | Unsupported | Typed constructors and sync/async methods; own/borrow | Standard resource bindings |
| Per-call cancellation | Unsupported | JoinHandle / host.cancel; optional `--abort-signal` | Upstream contract; differs from Core |
| Host shutdown | `host.dispose()` | `host.dispose()` | Upstream lifecycle; no Core host API |
| Standard Canonical ABI / native WIT async | Unsupported | Unsupported; private JS ABI | `--component` |
| npm library with JS and TS | Default `pkg/` output | Default `pkg/` output | `--component --npm-name ...` |

`taraba build` selects JSPI or Future from compiled runtime imports/exports and WIT requirements. It does not scan source for `async` keywords. Standard Component output remains explicit. Core instantiation uses native WebAssembly APIs and does not need jco; Component npm generation uses jco.

JSPI holds a per-instance queue through host I/O. A host callback must not await reentry into the same instance. A host rejection or Wasm trap closes that instance. Disposal rejects callers immediately, but the engine retains a suspended stack until its original I/O settles; it does not force Rust Drop or abort that I/O.

Future calls can progress independently while awaiting I/O. Shutdown cancels tasks and clears subscriptions, JS roots and provider references. With `--abort-signal`, cooperating host I/O also receives cancellation. An arbitrary Promise is not inherently cancellable. Small tasks stay in 128 B slots; larger or over-aligned tasks use a pinned Box. `--task-slots` configures capacity; pool exhaustion or heap OOM is fatal. See the [Core contract](core-runtime.md) and [typed lifecycle examples](typescript.md).

## TypeScript and helpers

Core Future covers numeric widths (64-bit integers use bigint), bool, char, string, list, tuple, record, option, result, variant, enum, flags and aliases. Named WIT types are exported to TS. Readonly inputs are accepted; numeric lists become TypedArrays. Strings and lists are copied, including returned arrays: these APIs do not lend Wasm memory views. WIT Result errors and foreign Promise rejections remain distinct.

Core Future supports imported methods and Rust-defined exported resource constructors and methods. Returned or nested borrows, resource static methods, guest resources crossing host imports, streams, nested futures and fixed-length lists remain unsupported. Component uses upstream bindings; Core tests do not establish support for every Component proposal. See [TypeScript interop](typescript.md).

`taraba-helpers` borrows JS RegExp (compile/test), strings and Unicode operations, Intl.Segmenter and non-streaming TextDecoder. Its iterator bridge consumes synchronous JS Iterators as Rust Iterators and closes them on early Drop. AsyncIterator, Rust Iterator → JS, URLPattern and general Map/Date/HTTP wrappers are not implemented. Only used operations and their shared foundation enter Core JS output. See [helpers](helpers.md) and [strings](strings.md).

## Distribution and runtime scope

Generated `pkg/` contains the entry point, TS declarations, Wasm, runtime assets, WIT and npm metadata, and can be packed independently. The CLI embeds its JS assets; a separate npm runtime dependency is unnecessary. `build --watch`, `update` and `insight` are available. Neither build nor update publishes packages.

Core builds check the Rust runtime ABI revision in the raw Wasm in addition to Cargo version compatibility. Missing, incompatible, malformed or duplicate metadata is rejected before optimization. `build.json` records the accepted revision; the marker is stripped from deployed Wasm. Rebuild older raw Wasm with the matching runtime and CLI.

The JS runtime is shared only when identical assets resolve to the same ESM URL in one realm. Separate default package paths require [explicit deduplication](esm-cache.md). Each instance retains its own state and memory. Current [scalar sizes](async-size.md), [rich async comparison](rich-async-size.md) and [tuning results](bundle-tuning.md) count Wasm and JS separately.

Core targets a single JS agent and rejects shared memory. `taraba-allocator` is a wee_alloc-derived allocator, not a multithreaded allocator. JSPI, GC and other modern Wasm features being allowed does not mean Rust heap objects use Wasm GC. There is no built-in WASI3 host, WASI implementation, Preview 1 adapter, HTTP server or general FFI generator; application I/O goes through WIT host callbacks. The JSPI Future adapter and concurrent stack-snapshot backend remain unadopted experiments.

## Verification boundary

| Area | Evidence and limit |
|---|---|
| Node/V8 and browser behavior | Local Rust/JS, pack/install and strict TS checks; Chrome 156 and Playwright WebKit 27.2 E2E passed |
| Safari 27+ | Complete: Playwright WebKit is the accepted Safari validation substitute; no additional Safari.app run is required |
| Cloudflare Workers | Existing fixtures run on local workerd; no production deployment verification |
| Component | jco execution and component validation; native Component-host execution remains unverified |
| Memory and ownership | Miri, bounded native64 Kani models and stress tests; not a proof of JS engines, generated Wasm or the complete ABI |
| GitHub Actions | Workflow jobs are configured; local results alone do not establish that a commit passed Actions |

See [development and reproduction](development.md) for commands and [release checks](releasing.md) for publication requirements.

[Core resource examples and limits](resources.md). Instance methods and Rust-defined resources require CLI and Rust runtime 0.2.1 or later.

Browser E2E passed [26 stable browser cases and 13 latest canary WebKit cases](browser-testing.md). Each canary run records its actual version, build and test results.
