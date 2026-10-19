# Core API reference

English | [日本語](core-runtime.ja.md)

For installation, WIT-first Component code and npm generation, use the [usage guide](guide.md). This page specifies the two **private Core/JS ABI** profiles. Standard Components use wit-bindgen/jco contracts and bypass this lowering.

The CLI selects Core JSPI/Future at build time from compiled runtime imports/exports and WIT resources. `--jspi` / `--future` override detection. This is not runtime fallback.

## Execution contracts

| Contract | Core/JSPI | Core Future |
|---|---|---|
| Rust imports | Synchronous-looking functions suspended by JSPI | Promise resources converted to JsFuture |
| Independent root calls while A waits | Queued per instance | May advance concurrently |
| Arbitrary Rust Pending Futures | No executor | Supported within the task-slot layout limit |
| Explicit cancellation | None | JoinHandle.cancel / host.cancel |
| Unhandled host reject / Wasm trap | First-fatal, instance closed | Fatal traps close instance; propagated Promise Err may reject one task |
| Rust Drop on a fatal JS exit | Not guaranteed | Not retried after a trap |
| WIT native async / record / string / list | Unsupported | Unsupported; use Component |

JSPI binding functions must not await reentry into the same instance: the outer call holds the queue until its I/O ends. There is no automatic fallback between these contracts.

Attach one instance, created using that host's imports, exactly once. Call through the host rather than raw instance export functions. JSPI rejects pre-attach calls and refuses reattachment or attachment to a closed host.

Core exposes one host factory: `createHost`. Use the standard WebAssembly API to instantiate a module.

## WIT boundaries

Both profiles support s32/u32/f64 and functions without results. JSPI accepts only these scalar boundaries. Future also accepts own/borrow handles to imported resources backed by JS references; borrow is limited to import arguments. Duplicate import function names across interfaces are rejected.

The Future scaffold uses this opaque contract:

```wit
package example:app@0.1.0;
interface js { resource promise; }
world app {
  import js;
  use js.{promise};
  import add: func(a: s32, b: s32) -> promise;
  export run: func(a: s32, b: s32) -> promise;
}
```

A resource is a non-undefined JS value; a Promise resource import returns a Promise. These handles are JS roots in this Core ABI, not Canonical resource-table handles. The scaffold's conversion between generated resource handles and JsPromise is specific to this profile. Prefer Component to express typed async results without this bridge.

## Generated JavaScript APIs

| Output | API |
|---|---|
| Core build without npm | `createHost({bindings})`, native instantiation with `host.imports`, then `host.attach(instance.exports)`; typed `host.run(...)` |
| Core npm entry | `createHost({bindings})`, native instantiation, then `host.attach(instance.exports)`; typed `host.run(...)` |
| Either | `host.stats()` |
| Future only | `host.activeTasks()` and `host.cancel(token)` |

Attach exactly once to an instance created with that host's imports. Call through the host rather than raw instance export functions. JSPI rejects pre-attach calls without closing the host and refuses attachment after a successful attach or fatal error.

Both `index.js` and the shared `runtime.mjs` export only `createHost`. The application factory exposes typed WIT methods. Use `WebAssembly.instantiate`, `instantiateStreaming` or `new WebAssembly.Instance`, then attach its exports.

Generated application methods return Promises in both profiles. The shared runtime has one private dispatch entry, `call(name, ...args)`; application bindings normalize Future results to Promises. There are no host-level `promise`, `root`, `get`, `take` or `release` aliases. `imports.jsrt` is the Future Wasm import namespace, not an application API: root/table/task imports are needed by the generated ownership bridge and Rust executor. Call only typed application methods. Select a particular task token deliberately; activeTasks is not a stable request-to-token mapping.

TypeScript's `AppBindings`, `AppExports`, `AppHostOptions`, and `AppHost` come from WIT in both Core output formats. `AppHost` extends `AppExports`, so WIT exports are direct methods returning Promises. The host reserves `imports`, `attach`, `stats`, `cancel`, `activeTasks`, and `then`; rename colliding WIT exports or use Component. The application-specific `index.js` imports the shareable `runtime.mjs`; deduplicate only the runtime. Scalar results are number; opaque Promise resource results remain **unknown**. A generic annotation on the lower-level host does not validate a payload at runtime. Use Component for WIT-typed async results and domain values.

## Rust Future crate

| API | Contract |
|---|---|
| `JsPromise.await` | Resolves to `Result<JsValue, JsValue>` |
| `future_to_promise(future)` | Future output is `Result<JsValue, JsValue>`; Future must be static |
| `spawn_local(future)` | Static Future output `()`; returns JoinHandle |
| `JoinHandle.cancel()` | Explicitly drops a live task and its subscriptions |
| Drop JoinHandle | Detaches the task |
| `JoinHandle.into_promise()` | Transfers the completion Promise |
| `JsValue` Clone / Drop | Retains/releases a host root; does not clone the JS object |

The embedding application chooses its allocator and, for no_std, its panic handler. Fixed task storage is **1,024 × 128 B**, including header, ID and Future, with alignment ≤64. This is not a general executor for larger Futures; exhaustion/oversize is fatal OOM. The allocator for Vec/Box is separate from these slots. JsValue and JsPromise are local to one JS agent and instance. The Core builder rejects shared memory. Function names, signatures and bindings follow the WIT/generated TypeScript contract; the runtime does not repeat their type checks or inspect SharedArrayBuffer availability. JSPI receives its export names from the generated application API. Attach/fatal state and Future ownership/task invariants are checked at runtime.

`JsFuture` reuses one owned JS value slot: it holds the Promise while pending and the result after settlement. Completion releases the Promise root before waking the latest registered Waker; consuming the result transfers its ownership to the caller. Subscription identity, external Waker support and cancellation/Drop behavior remain independent of this storage reuse.

`export_runtime!()` emits the private runtime exports once. The generated Future scaffold supplies it and the ownership conversion. Do not invoke poll/drop/settle or manufacture raw handles from user code.

## Errors, features and verification

Opt into `taraba::panic::set_hook()` with std, or call `taraba::panic::handler(info)` from the application's no_std handler, to report a panic as a JS Error. Release reports only `PN01` and its URL. See [setup, diagnostic builds and size limits](panic-reporting.md).

`--debug` gives descriptive Core JS errors; release messages contain a code and a link to the [error reference](error-codes.md), without an embedded description table or a dictionary sidecar. First-fatal handling preserves the first reason and clears JS roots. Cancel does not abort arbitrary host network I/O; late subscriptions are retired safely. A Rust trap during Drop closes the instance and Drop is not retried.

The JavaScript baseline is Safari 27+ / JSPI-capable V8. The runtime calls JSPI builtins directly without feature detection. Safari hardware remains unverified. Optional GC/js-string/exnref/funcref capability tests do not imply every runtime uses those features.

[Verification commands](development.md), [current size comparison](async-size.md), [adoption gates](jspi-adoption.md). Kani verifies selected native64 models/components; it is not a proof of JS engines, emitted Wasm or the whole ABI.
