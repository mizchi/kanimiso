# Core API reference

English | [日本語](core-runtime.ja.md)

For installation, WIT-first Component code and npm generation, use the [usage guide](guide.md). This page specifies the two **private Core/JS ABI** profiles. Standard Components use wit-bindgen/jco contracts and bypass this lowering.

The CLI selects Core JSPI/Future at build time from compiled runtime imports/exports and WIT resources. `--jspi` / `--future` override detection. This is not runtime fallback.

Core builds validate the compiled Rust runtime ABI independently of SemVer. `export_runtime!()` emits the revision, and missing/incompatible/duplicate/malformed revisions fail before optimization or output replacement. The accepted revision appears in `build.json`; metadata adds no bytes to deployed Wasm. Rebuild older raw inputs with the matching runtime crate and CLI.

## Execution contracts

| Contract                                        | Core/JSPI                                       | Core Future                                                            |
| ----------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| Rust imports                                    | Synchronous-looking functions suspended by JSPI | Generated async imports returning `HostResult<T>`                      |
| Independent root calls while A waits            | Queued per instance                             | May advance concurrently                                               |
| Arbitrary Rust Pending Futures                  | No executor                                     | Inline small Futures; automatic Box fallback for larger ones                            |
| Explicit cancellation                           | None                                            | JoinHandle.cancel / host.cancel / opt-in AbortSignal                                        |
| Unhandled host reject / Wasm trap               | First-fatal, instance closed                    | Fatal traps close instance; propagated Promise Err may reject one task |
| Rust Drop on a fatal JS exit                    | Not guaranteed                                  | Not retried after a trap                                               |
| Standard Canonical ABI | Unsupported | Unsupported; use Component |
| record / string / list | Unsupported | Supported by typed world and interface bindings |

JSPI binding functions must not await reentry into the same instance: the outer call holds the queue until its I/O ends. There is no automatic fallback between these contracts.

Attach one instance, created using that host's imports, exactly once. Call through the host rather than raw instance export functions. JSPI rejects pre-attach calls and refuses reattachment or attachment to a closed host.

Core exposes one host factory: `createHost`. Use the standard WebAssembly API to instantiate a module.

## WIT boundaries

Both profiles support s32/u32/f64 and functions without results. JSPI accepts only these scalar boundaries. The typed Future facade also supports the value types listed below. Legacy synchronous Future bindings accept own/borrow handles to imported resources backed by JS references; typed bindings also accept direct exported borrow arguments. Typed interface bindings preserve namespaces, including duplicate method names across interfaces.

The Future scaffold starts with world-level typed async functions. Named interfaces are also supported; see [interface and resource examples](typescript.md#interfaces-and-resource-lifetimes).

```wit
package example:app@0.1.0;
world app {
  import add: func(a: s32, b: s32) -> future<s32>;
  export run: func(a: s32, b: s32) -> future<s32>;
}
```

`async func(a: s32, b: s32) -> s32` is equivalent in this Core profile. World-level and interface synchronous and asynchronous functions support numeric types, bool, char, string, list, option, result, tuple, record, variant, enum, flags and type aliases. Imported opaque own/borrow resources also support typed async. Resource methods, Rust-defined exported resources, returned/nested borrows, streams, nested futures and fixed-size lists are outside Core. Use `--component` for standard resource bindings; other type/proposal support follows the upstream toolchain and is not established by Core tests.

The generated `build.rs` runs `taraba bindgen` into Cargo's OUT_DIR. Include `bindings.rs`, invoke `bindings!()`, implement the generated `Guest` trait with `async fn` returning `HostResult<T>`, and invoke `export!(App)`. Imports are safe async functions; `?` propagates host Promise rejections without changing the JS error identity. See the [complete example](../README.md#minimal-example).

These WIT declarations generate a facade over the existing private Core Promise/resource ABI. They do not implement standard Canonical future handles or Component async scheduling. The facade owns handle transfers internally. Its public WIT metadata is checked against the build input and stripped before optimization; no metadata or extra JS is shipped. `taraba build` supplies its own CLI path and selected WIT/world to the build script. Direct `cargo build` needs the updated CLI on PATH, or `TARABA_BINDGEN` set to its executable.

Existing manually bound resources remain supported. Such a resource represents a non-undefined JS value; its handles are JS roots, not Canonical resource-table handles. An opaque Promise resource retains an unknown payload type.

Imported `resource value { constructor(...); }` generates a synchronous typed factory: Rust `imports::io::value(...)` and JS `bindings.io.value(...)` for an interface imported as `io`. The returned owner follows the same own/borrow/Drop rules as freestanding resource functions. See [constructor and lifecycle examples](typescript.md#interfaces-and-resource-lifetimes).

## Value types and selective code generation

The shared `runtime.mjs` gains no type-specific code. The generator traverses types reachable from WIT function signatures, then emits only the codec imports retained by optimized Wasm into `index.js`. Unused types, unused imports and unused codec directions add no deployed code.

| WIT | Rust | JavaScript / TypeScript |
| --- | --- | --- |
| s8/s16/s32, u8/u16/u32, f32/f64 | corresponding numeric type | number |
| s64 / u64 | i64 / u64 | bigint |
| bool | bool | boolean |
| char | char | string containing one Unicode scalar |
| string | String | string |
| Numeric list<T> | Vec<T> | matching TypedArray (readonly arrays also accepted as inputs) |
| Other list<T> | Vec<T> | Array<T> |
| option<T> | Option<T> | T or undefined; nested options keep their outer tag |
| result<T,E> | Result<T,E> | `{tag:"ok", val:T}` / `{tag:"err", val:E}`; unit payloads may omit val |
| tuple<...> | tuple | tuple array |
| record | generated struct | object |
| variant | generated enum | `{tag:"case", val:...}` |
| enum | generated enum | case-name string union |
| flags | generated struct of bool fields | object of boolean fields |

JS field names and tags preserve WIT spelling. Rust type and enum case names use PascalCase; fields use snake_case. Strings and lists are copied into owned Rust String / Vec values. UTF-8 encoding replaces lone JS surrogates with U+FFFD. The host must provide one Unicode scalar for char; TypeScript represents it as string.

Named WIT types are also exported to TS. `WitInput<T>` accepts readonly containers; simple option fields become optional properties. See the [TypeScript interop example](typescript.md) for typed bindings, bytes and Result handling.

```wit
package example:messages;
world app {
  record message { text: string, ids: list<u64> }
  type response = result<message, string>;
  import enrich: func(value: message) -> future<response>;
  export run: async func(value: message) -> response;
}
```

```rust
include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
bindings!();
struct App;
impl Guest for App {
    async fn run(value: Message) -> HostResult<Response> {
        enrich(value).await
    }
}
export!(App);
```

The host's enrich callback receives a Message object and returns `{tag:"ok", val: message}` or `{tag:"err", val: "reason"}`. A WIT result is a domain value. Promise rejection instead becomes the outer HostResult error; propagating it with `?` rejects the exported Promise with the same JS exception.

`just core-types-check` verifies std / no_std round trips, ownership, strict TypeScript and zero deployed bytes for unused types. `just compare-core-types` records per-type sizes in `docs/core-types-size.json`.

These no_std samples await one host echo and return the same value. Sizes are after wasm-opt / JS minify, before compression. JS includes the same 3,585 B shared runtime. Growth includes type conversion and Rust allocation code; the shared runtime does not grow.

<!-- core-types-size:begin -->
| WIT value type | Wasm | JS (including shared runtime) | Wasm growth vs s32 | JS growth vs s32 |
| --- | ---: | ---: | ---: | ---: |
| `s32` | 1394 B | 3695 B | +0 B | +0 B |
| `bool` | 1461 B | 3751 B | +67 B | +56 B |
| `u64` | 1469 B | 3856 B | +75 B | +161 B |
| `string` | 2554 B | 4158 B | +1160 B | +463 B |
| `list<u8>` | 2554 B | 4079 B | +1160 B | +384 B |
<!-- core-types-size:end -->

## Generated JavaScript APIs

| Output                 | API                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Core `pkg/index.js`     | `createHost({bindings})`, native instantiation with `host.imports`, then `host.attach(instance.exports)`; typed `host.run(...)` |
| Either                 | `host.stats()` / `host.dispose()`                                                                                                |
| Future only            | `host.activeTasks()` and `host.cancel(token)`                                                                                   |

Attach exactly once to an instance created with that host's imports. Call through the host rather than raw instance export functions. JSPI rejects pre-attach calls without closing the host and refuses attachment after a successful attach or fatal error.

Both `index.js` and the shared `runtime.mjs` export only `createHost`. The application factory exposes typed WIT methods. Use `WebAssembly.instantiate`, `instantiateStreaming` or `new WebAssembly.Instance`, then attach its exports.

Generated application methods return Promises in both profiles. The shared runtime has one private dispatch entry, `call(name, ...args)`; application bindings normalize Future results to Promises. There are no host-level `promise`, `root`, `get`, `take` or `release` aliases. `imports.jsrt` is the Future Wasm import namespace, not an application API: root/table/task imports are needed by the generated ownership bridge and Rust executor. Call only typed application methods. Select a particular task token deliberately; activeTasks is not a stable request-to-token mapping.

TypeScript's `AppBindings`, `AppExports`, `AppHostOptions`, and `AppHost` come from WIT for both Core execution profiles. `AppHost` extends `AppExports`, so WIT exports are direct methods returning Promises. The host reserves `imports`, `attach`, `stats`, `cancel`, `activeTasks`, `dispose`, and `then`; rename colliding WIT exports or use Component. The application-specific `index.js` imports the shareable `runtime.mjs`; deduplicate only the runtime. Scalar results are number; typed `future<s32>` / `future` exports return `Promise<number>` / `Promise<void>`. Import callbacks accept the matching value or PromiseLike. Legacy opaque Promise resources remain **unknown**. TypeScript annotations do not validate payloads at runtime. Use Component for standard async ABI interoperability.

Both profiles expose idempotent `host.dispose()`. Future tasks are cancelled and dropped, and host roots/subscriptions are cleared. With `--abort-signal`, cooperating I/O receives cancellation. JSPI callers reject immediately, while suspended stacks remain engine-owned until the original I/O settles; this does not force Rust Drop or abort I/O. See [lifecycle and per-call cancellation](typescript.md).

## Rust Future crate

| API                         | Contract                                                           |
| --------------------------- | ------------------------------------------------------------------ |
| `JsPromise.await`           | Resolves to `Result<JsValue, JsValue>`                             |
| `future_to_promise(future)` | Future output is `Result<JsValue, JsValue>`; Future must be static |
| `spawn_local(future)`       | Static Future output `()`; returns JoinHandle                      |
| `JoinHandle.cancel()`       | Explicitly drops a live task and its subscriptions                 |
| Drop JoinHandle             | Detaches the task                                                  |
| `JoinHandle.into_promise()` | Transfers the completion Promise                                   |
| `JsValue` Clone / Drop      | Retains/releases a host root; does not clone the JS object         |

The embedding application chooses its allocator and, for no_std, its panic handler. Default static task storage is **1,024 × 128 B** (configurable with `--task-slots`), including header, ID and Future, with alignment ≤64. The size decision is constant per Future type: if the full task exceeds 128 B or alignment 64, the runtime pins the Future in a Box and stores its pointer in the pool. Small Futures keep their existing storage and do not link fallback allocation code. Pool exhaustion or heap OOM remains fatal; the pool limits concurrent tasks to the configured slot count. The allocator for Vec/Box is separate from these slots. JsValue and JsPromise are local to one JS agent and instance. The Core builder rejects shared memory. Function names, signatures and bindings follow the WIT/generated TypeScript contract; the runtime does not repeat their type checks or inspect SharedArrayBuffer availability. JSPI receives its export names from the generated application API. Attach/fatal state and Future ownership/task invariants are checked at runtime.

Generated bindings also contribute to the Future layout. Automatic boxing works with std and no_std + alloc, using the application allocator. Very large values may still need explicit heap construction to limit stack use.

`JsFuture` reuses one owned JS value slot: it holds the Promise while pending and the result after settlement. Completion releases the Promise root before waking the latest registered Waker; consuming the result transfers its ownership to the caller. Subscription identity, external Waker support and cancellation/Drop behavior remain independent of this storage reuse.

`export_runtime!()` emits the private runtime exports once. The generated `export!(App)` invokes it and supplies the ownership conversion. Do not invoke poll/drop/settle or manufacture raw handles from user code.

## Errors, features and verification

Opt into `taraba::panic::set_hook()` with std, or call `taraba::panic::handler(info)` from the application's no_std handler, to report a panic as a JS Error. Release reports only `PN01` and its URL. See [setup, diagnostic builds and size limits](panic-reporting.md).

`--debug` gives descriptive Core JS errors; release messages contain a code and a link to the [error reference](error-codes.md), without an embedded description table or a dictionary sidecar. First-fatal handling preserves the first reason and clears JS roots. Cancel does not abort arbitrary host network I/O; late subscriptions are retired safely. A Rust trap during Drop closes the instance and Drop is not retried.

The JavaScript baseline is Safari 27+ / JSPI-capable V8. The runtime calls JSPI builtins directly without feature detection. Safari hardware remains unverified. Optional GC/js-string/exnref/funcref capability tests do not imply every runtime uses those features.

[Verification commands](development.md), [current size comparison](async-size.md), [adoption gates](jspi-adoption.md). Kani verifies selected native64 models/components; it is not a proof of JS engines, emitted Wasm or the whole ABI.

[Interfaces, resources, disposal and configurable task capacity](typescript.md#interfaces-and-resource-lifetimes).

Strings use UTF-8 produced by the generated TextEncoder import, avoiding a second Rust UTF-8 validation. Replacing generated private codecs is outside the contract. Copying uses non-shared memory and a fresh zero-initialized Vec; ill-formed UTF-16 follows TextEncoder replacement rules. [Before/after sizes](bundle-tuning.md).
