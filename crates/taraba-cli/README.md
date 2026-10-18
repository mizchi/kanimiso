# taraba-cli

Native build tool for [taraba](https://github.com/mizchi/taraba). The first crates.io release is being prepared; the commands below describe usage after publication.

```sh
cargo install taraba-cli --version 0.1.0 --locked
taraba new hello --no-std
cd hello
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/hello.wasm --wit wit --out-dir pkg
```

The default is scalar WIT/Core JSPI for Safari 27+ / JSPI-capable V8. Rust calls synchronous imports; native Promises suspend and resume execution through JSPI. Supported boundaries are s32/u32/f64 and functions without results. There is no Rust executor, task pool, cancellation, or resource handle support in this profile. Missing JSPI is rejected without a fallback. Safari 27 has not been verified in a real browser.

Calls, including I/O waits, serialize per instance to protect LLVM's linear-memory stack. A slow call blocks later calls on that instance. Bindings must not await same-instance reentry. Host rejection or a Wasm trap permanently closes the instance with the first reason; Rust Drop is not guaranteed on that path.

Use `--future` on both `new` and `build` for the optional existing Rust Future / spawn_local / cancel backend. It allows independent tasks to advance while another task waits for I/O and supports imported resource own/borrow handles (borrow only on import arguments). Existing Future commands must add this flag. `--jspi` explicitly selects the default and cannot be combined with `--future`. Backend selection is explicit; WIT does not silently switch it.

Install the Rust wasm32-unknown-unknown target and Binaryen 133. JSPI needs wasm-opt; Future also needs wasm-as, wasm-merge, and wasm-metadce. Set TARABA_BINARYEN to its bin directory if it is not on PATH.

JS, declarations, error codes, and pool WAT are embedded. No repository checkout, Node, or esbuild is required to build a consumer. Deploy pkg/app.wasm with its matching pkg/taraba.mjs. Use --debug for descriptive JS errors. The emitted declarations describe the selected profile.

WIT is parsed with official wit-parser; Rust bindings use official wit-bindgen. This Core lowering is not the Component Model Canonical ABI. Native WIT async is measured separately in the repository's Component experiment.

The intended Future extension on JSPI remains experimental. The existing Future backend stays available until concurrency, cancellation/Drop, and concurrent memory/performance checks pass. See the [adoption decision](https://github.com/mizchi/taraba/blob/main/docs/jspi-adoption.md).

Full documentation is available in English and Japanese in the repository. MIT license; the separately distributed allocator is MPL-2.0.
