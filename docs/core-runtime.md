# Core API reference

English | [日本語](core-runtime.ja.md)

For installation, WIT-first Component code and npm generation, use the [usage guide](guide.md). This page specifies the two **private Core/JS ABI** profiles. Standard Components use wit-bindgen/jco contracts and bypass this lowering.

## Execution contracts

| Contract | Default Core/JSPI | Core Future (`--future`) |
|---|---|---|
| Rust imports | Synchronous-looking functions suspended by JSPI | Promise resources converted to JsFuture |
| Independent root calls while A waits | Queued per instance | May advance concurrently |
| Arbitrary Rust Pending Futures | No executor | Supported within the task-slot layout limit |
| Explicit cancellation | None | JoinHandle.cancel / host.cancel |
| Unhandled host reject / Wasm trap | First-fatal, instance closed | Fatal traps close instance; propagated Promise Err may reject one task |
| Rust Drop on a fatal JS exit | Not guaranteed | Not retried after a trap |
| WIT native async / record / string / list | Unsupported | Unsupported; use Component |

JSPI binding functions must not await reentry into the same instance: the outer call holds the queue until its I/O ends. There is no automatic fallback between these contracts.

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
| Core build without npm | `instantiate(source, {bindings})`, then guarded `host.call(name, ...args)` / `host.promise(name, ...args)` |
| Core npm entry | `instantiate(source, {bindings})`, then typed `host.exports.run(...)` |
| Either | `host.stats()` |
| Future only | `host.activeTasks()` and `host.cancel(token)` |

`source` is a BufferSource or compiled WebAssembly.Module. JSPI call/promise both return Promises. Future call returns the direct result and promise adopts it. npm application exports return Promises in both profiles. Private root/table/rt_* methods are not an application API: always use guarded calls. Select a particular task token deliberately; activeTasks is not a stable request-to-token mapping.

TypeScript's AppBindings/AppExports come from WIT. Scalar results are number; opaque Promise resource results remain **unknown**. A generic annotation on the lower-level host does not validate a payload at runtime. Use Component for WIT-typed async results and domain values.

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

The embedding application chooses its allocator and, for no_std, its panic handler. Fixed task storage is **1,024 × 128 B**, including header, ID and Future, with alignment ≤64. This is not a general executor for larger Futures; exhaustion/oversize is fatal OOM. The allocator for Vec/Box is separate from these slots. JsValue and JsPromise are local to one JS agent and instance. Atomics/shared-memory instances are outside the supported contract.

`export_runtime!()` emits the private runtime exports once. The generated Future scaffold supplies it and the ownership conversion. Do not invoke poll/drop/settle or manufacture raw handles from user code.

## Errors, features and verification

`--debug` gives descriptive Core JS errors; release uses short RT codes and an external error-codes.json. First-fatal handling preserves the first reason and clears JS roots. Cancel does not abort arbitrary host network I/O; late subscriptions are retired safely. A Rust trap during Drop closes the instance and Drop is not retried.

The JavaScript baseline is Safari 27+ / JSPI-capable V8. Missing JSPI fails with RT15. Safari hardware remains unverified. Optional GC/js-string/exnref/funcref capability tests do not imply every runtime uses those features.

[Verification commands](development.md), [current size comparison](async-size.md), [adoption gates](jspi-adoption.md). Kani verifies selected native64 models/components; it is not a proof of JS engines, emitted Wasm or the whole ABI.
