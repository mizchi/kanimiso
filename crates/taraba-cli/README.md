# taraba-cli

Native build tool for [taraba](https://github.com/mizchi/taraba). The first crates.io release is being prepared; the commands below describe usage after publication.

```sh
cargo install taraba-cli --version 0.1.0 --locked
taraba new hello --no-std --jspi
cd hello
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/hello.wasm --wit wit --out-dir pkg --jspi
```

Install the Rust wasm32-unknown-unknown target and Binaryen 133 (wasm-opt/as/merge/metadce). Set TARABA_BINARYEN to its bin directory if it is not on PATH.

JS, declarations, error codes, and pool WAT are embedded. No repository checkout, Node, or esbuild is required to build a consumer. Deploy pkg/app.wasm with pkg/taraba.mjs. Use --debug for descriptive JS errors.

WIT is parsed with official wit-parser. The lightweight Core profile supports s32/u32/f64 and imported resource own/borrow handles (borrow only on import arguments). Rust binding generation uses official wit-bindgen. This Core profile maps JS roots to externref and is not the Component Model Canonical ABI. WIT native async is measured separately in the repository's Component experiment.

Full documentation is available in English and Japanese in the repository. MIT license; the separately distributed allocator is MPL-2.0.

The experimental --jspi profile targets Safari 27+ / JSPI-capable V8 and supports synchronous scalar WIT functions (s32/u32/f64). It serializes guest entry per instance and closes the instance on host rejection or a Wasm trap. It has no Rust executor, task pool, cancellation, or resource handles. It needs only wasm-opt from Binaryen; the Future profile uses all four tools. Missing JSPI is rejected without a fallback.

Omit --jspi to use the existing Rust Future / spawn_local / cancel profile. The emitted declarations describe the selected profile.
