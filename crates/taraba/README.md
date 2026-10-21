# taraba

The optional Core Future backend for taraba libraries: a small Promise-first executor for Rust on non-shared, single-agent wasm32.
Provides `spawn_local`, `future_to_promise`, `JsPromise`, and `JsValue` for JavaScript hosts.

Requires Rust 1.85 or later. Add the crate from crates.io:

```sh
cargo add taraba@0.2.0
rustup target add wasm32-unknown-unknown
```

The library supports `no_std` by default. Enable `std` when needed.
A no_std application chooses its own panic handler and general allocator;
`taraba-allocator` is an optional MPL-2.0 allocator.

Both Core JSPI and Future applications can opt into `taraba::panic::set_hook()`
(`std`) or call `taraba::panic::handler(info)` from their no_std panic handler.
Release reports `PN01` and its documentation URL without formatting hook
information; std may format a dynamic payload before invoking the hook.
`panic-details` enables diagnostic text for the CLI's `--debug` host.
This does not remove std's panic infrastructure. See
[panic reporting](https://github.com/mizchi/taraba/blob/main/docs/panic-reporting.md).

The matching JS glue and application build tooling are distributed with `taraba-cli`.
See the [English README](https://github.com/mizchi/taraba#readme) or
[日本語 README](https://github.com/mizchi/taraba/blob/main/README.ja.md) for integration details.

Task storage defaults to 128 B × 1024 slots (alignment ≤64), including each Future and header. CLI/runtime 0.2.0 support `taraba build --task-slots N` to configure capacity at compile time.
Larger or over-aligned Futures are automatically pinned in a Box; small Futures stay inline without linking the fallback. Pool exhaustion and heap OOM remain fatal. Dropping a JoinHandle detaches;
explicit cancellation drops a task. Fatal errors close the instance and preserve the first exception.

The CLI targets Safari 27+ / JSPI-capable V8. Start with `taraba new app --future`; `taraba build` automatically selects this executor from compiled runtime imports/exports and WIT resources. `--jspi` / `--future` can override detection. The default profile calls synchronous guest functions through JSPI and does not depend on this Future executor. See the repository documentation for its serialized-entry and fatal-error contract.

The Core typed facade generates safe async Rust/TS bindings for records, lists, strings and other WIT value types in world and interface functions. Imported opaque resources support freestanding own/borrow functions, including typed async. Use matching CLI and Rust crates 0.2.0 or later. Core does not support resource methods, Rust-defined exported resources, returned/nested borrows, streams, nested futures or fixed-length lists. For standard Component interoperability and resource bindings, use `taraba new --component` and the wit-bindgen Component API; proposal support follows that toolchain. That path uses the Component toolchain executor and does not depend on this Core runtime crate. `taraba build --npm-name ...` packages either execution contract for npm; the Component path includes jco-generated TypeScript. See the root README for use cases.

`export_runtime!()` emits the private host ABI once per cdylib. Its hidden
`__private` bridge and the `test-api` fixture feature are implementation details,
not supported application APIs. Task storage is private.

`host.dispose()` cancels tasks, clears subscriptions and releases runtime-owned JS references. See [lifecycle and limits](https://github.com/mizchi/taraba/blob/main/docs/status.md).

The CLI option `taraba build --abort-signal` adds typed per-call cancellation and a host callback signal for I/O. It is opt-in and adds no Wasm code. See the [TypeScript guide](https://github.com/mizchi/taraba/blob/main/docs/typescript.md#per-call-cancellation).
