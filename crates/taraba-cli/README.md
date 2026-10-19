# taraba-cli

Build WIT-based Rust/Wasm **libraries**, as standard Components or npm packages with JavaScript and TypeScript declarations. Native WIT async uses official wit-bindgen and jco; Core profiles provide size/concurrency alternatives.

| Requirement | Options |
|---|---|
| Component Model / Canonical ABI / WIT async | `new --component`, `build --component` |
| npm library with typed async/domain values | `build --component --npm-name @scope/library` |
| Small numeric JSPI npm library | `build --npm-name @scope/library` (default Core/JSPI) |
| Existing concurrent Future/spawn_local/cancel runtime | `new --future`, `build --future`; npm optional |

The first crates.io release is being prepared. After publication:

```sh
cargo install taraba-cli --version 0.1.0 --locked
taraba new hello --component --no-std
cd hello
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/hello.wasm --wit wit --component
```

This emits a validated `app.component.wasm`, encoded WIT and build metadata. Add `--npm-name @scope/library --npm-version 0.1.0 --license MIT` to generate JS, application-specific TS, all core Wasm files, and `package.json` with ESM/types exports and an explicit file list. `pnpm pack` creates a distributable tarball. No command publishes a package. Opaque Core resource payloads stay `unknown`; Component bindings retain WIT types and `Promise<T>` results.

The generated justfile contains library and npm build tasks. Select an execution contract explicitly on both `new` and `build`; WIT does not silently select it.

Use `taraba build --watch` (`just watch` in a new scaffold) to watch a Cargo project and its WIT/local path dependencies. It runs Cargo release builds for wasm32-unknown-unknown, then regenerates the selected output. Pass `--component` or `--future` as needed; npm options work in watch mode too. Select workspace packages with `--manifest-path` / `--package`, and features with `--features` / `--no-default-features`. WIT defaults to the selected package's `wit/` directory. Custom target and library names are read from Cargo artifact messages.

Builds are serialized and debounced; edits during a build are queued. The output directory is reserved for generated files and is replaced only after successful generation. Failed builds keep the previous output and retry after edits. Cargo's target directory, generated output and dependency caches are excluded from monitoring. Stop with Ctrl-C. With a positional input (`taraba build input.wasm --wit wit --watch`), only Wasm/WIT regeneration is watched; Cargo compilation stays with the external build process.

Requires Rust's wasm32-unknown-unknown target and Binaryen 133. Component builds also need wasm-tools 1.245.1 (`--wasm-tools` selects its path). Component npm builds need Node.js 24+ and jco 1.39.0 (`--jco` selects its path). Core JS assets are embedded: no checkout, Node/esbuild, or jco is needed to build Core artifacts. JSPI needs wasm-opt; Future also needs wasm-as, wasm-merge and wasm-metadce. Set TARABA_BINARYEN or --binaryen for a non-PATH installation.

JavaScript async targets Safari 27+ / JSPI-capable V8; real Safari execution is unverified. Default Core/JSPI serializes instance entry including I/O, treats reject/trap as fatal, and provides no arbitrary Future executor or cancellation. The Future profile has its own ownership/cancellation contract. Native Component async follows the Component toolchain contract; it is not an implementation of the Core runtime. The scaffold does not supply WASI implementations or Preview 1 adapters.

See the [English guide](https://github.com/mizchi/taraba/blob/main/docs/guide.md), [日本語ガイド](https://github.com/mizchi/taraba/blob/main/docs/guide.ja.md), and [Core runtime reference](https://github.com/mizchi/taraba/blob/main/docs/core-runtime.md).

MIT. The optional taraba-allocator is separately licensed MPL-2.0.
