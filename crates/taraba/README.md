# taraba

A small Promise-first executor for Rust on non-shared, single-agent wasm32.
Provides `spawn_local`, `future_to_promise`, `JsPromise`, and `JsValue` for JavaScript hosts.

The crate is being prepared for its first crates.io release. After publication:

```sh
cargo add taraba@0.1.0
rustup target add wasm32-unknown-unknown
```

The library supports `no_std` by default. Enable `std` when needed.
A no_std application chooses its own panic handler and general allocator;
`taraba-allocator` is an optional MPL-2.0 allocator.

The matching JS glue and application build tooling are distributed with `taraba-cli`.
See the [English README](https://github.com/mizchi/taraba#readme) or
[日本語 README](https://github.com/mizchi/taraba/blob/main/README.ja.md) for integration details.

Task storage is fixed at 128 B × 1024 slots (alignment ≤64), including each Future and header.
Larger Futures or an exhausted task pool cause a fatal OOM. Dropping a JoinHandle detaches;
explicit cancellation drops a task. Fatal errors close the instance and preserve the first exception.

The CLI also offers an experimental `--jspi` scalar WIT profile for Safari 27+ / JSPI-capable V8. That profile calls synchronous guest functions through JSPI and does not depend on this Future executor. See the repository documentation for its serialized-entry and fatal-error contract.
