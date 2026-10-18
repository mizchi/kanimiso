# kanimiso-cli

Native build tool for [kanimiso](https://github.com/mizchi/kanimiso). The first crates.io release is being prepared; the commands below describe usage after publication.

```sh
cargo install kanimiso-cli --version 0.1.0 --locked
kanimiso new hello --no-std
cd hello
cargo build --release --target wasm32-unknown-unknown
kanimiso build target/wasm32-unknown-unknown/release/hello.wasm --wit wit --out-dir pkg
```

Install the Rust wasm32-unknown-unknown target and Binaryen 133 (wasm-opt/as/merge/metadce). Set KANIMISO_BINARYEN to its bin directory if it is not on PATH.

JS, declarations, error codes, and pool WAT are embedded. No repository checkout, Node, or esbuild is required to build a consumer. Deploy pkg/app.wasm with pkg/kanimiso.mjs. Use --debug for descriptive JS errors.

WIT is parsed with official wit-parser. The lightweight Core profile supports s32/u32/f64 and imported resource own/borrow handles (borrow only on import arguments). Rust binding generation uses official wit-bindgen. This Core profile maps JS roots to externref and is not the Component Model Canonical ABI. WIT native async is measured separately in the repository's Component experiment.

Full documentation is available in English and Japanese in the repository. MIT license; the separately distributed allocator is MPL-2.0.
