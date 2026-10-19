# taraba

The optional Core Future backend for taraba libraries: a small Promise-first executor for Rust on non-shared, single-agent wasm32.
Provides `spawn_local`, `future_to_promise`, `JsPromise`, and `JsValue` for JavaScript hosts.

Requires Rust 1.85 or later. Add the crate from crates.io:

```sh
cargo add taraba@0.1.0
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

Task storage is fixed at 128 B × 1024 slots (alignment ≤64), including each Future and header.
Larger Futures or an exhausted task pool cause a fatal OOM. Dropping a JoinHandle detaches;
explicit cancellation drops a task. Fatal errors close the instance and preserve the first exception.

The CLI targets Safari 27+ / JSPI-capable V8. Start with `taraba new app --future`; `taraba build` automatically selects this executor from compiled runtime imports/exports and WIT resources. `--jspi` / `--future` can override detection. The default profile calls synchronous guest functions through JSPI and does not depend on this Future executor. See the repository documentation for its serialized-entry and fatal-error contract.

For a WIT-first library with typed async results, records, lists and strings, use `taraba new --component` and the standard wit-bindgen Component API. That path uses the Component toolchain executor and does not depend on this Core runtime crate. `taraba build --npm-name ...` packages either execution contract for npm; the Component path includes jco-generated TypeScript. See the root README for use cases.

`export_runtime!()` emits the private host ABI once per cdylib. Its hidden
`__private` bridge and the `test-api` fixture feature are implementation details,
not supported application APIs. Task storage is private.
