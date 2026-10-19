# taraba-cli

Build WIT-based Rust/Wasm **libraries**, as standard Components or npm packages with JavaScript and TypeScript declarations. Native WIT async uses official wit-bindgen and jco; Core profiles provide size/concurrency alternatives.

| Requirement | Options |
|---|---|
| Component Model / Canonical ABI / WIT async | `new --component`, `build --component` |
| npm library with typed async/domain values | `build --component --npm-name @scope/library` |
| Small numeric JSPI npm library | `build` (default Core/JSPI); optional `--npm-name` override |
| Existing concurrent Future/spawn_local/cancel runtime | `new --future`, then `build` (auto-detected); npm directory by default |
| Inspect optimized sizes and formatting retention | `build --insight`, then `insight --paths fmt`; optional `--json` / `--retained` |

Requires Rust 1.85 or later. Install the CLI from crates.io:

```sh
cargo install taraba-cli --version 0.1.0 --locked
rustup target add wasm32-unknown-unknown
taraba new hello --component --no-std
cd hello
taraba build --component
```

Core output exposes `createHost({bindings})`: instantiate Wasm with the standard `WebAssembly.instantiate(bytes, host.imports)`, then `host.attach(instance.exports)`. Call typed WIT exports directly, for example `await host.run(20, 21)`. Core builds generate an npm directory with `index.js`, `index.d.ts` and `package.json`, including `AppBindings` and `AppHost`, so binding callbacks and host methods receive types. The application-specific `index.js` imports the shared `runtime.mjs`. Core exports only `createHost`; native WebAssembly APIs handle loading and instantiation. Component output uses jco's standard loader API.

This emits a validated `app.component.wasm`, encoded WIT and build metadata. Add `--npm-name @scope/library --npm-version 0.1.0 --license MIT` to generate JS, application-specific TS, all core Wasm files, and `package.json` with ESM/types exports and an explicit file list. `pnpm pack` creates a distributable tarball. No command publishes a package. Opaque Core resource payloads stay `unknown`; Component bindings retain WIT types and `Promise<T>` results.

Core package names, versions and licenses default to the selected Cargo package metadata (missing license: UNLICENSED). Override each independently with `--npm-name`, `--npm-version` and `--license`. Run `pnpm pack` or `pnpm publish --access public` inside `pkg/`; no source checkout or build tool is needed by consumers. Raw Wasm input defaults to its lowercased filename stem, 0.1.0 and UNLICENSED.

The generated justfile provides optional shortcuts for the CLI commands. `taraba build` runs Cargo release compilation for wasm32-unknown-unknown, using Cargo.toml, the selected package's wit/ and pkg/ output by default. Core JSPI/Future is detected from compiled runtime imports/exports and WIT resources, not Rust source keywords. `--jspi` / `--future` override detection. Component output remains explicit with `--component`.

After upgrading the CLI with `cargo install taraba-cli --locked --force`, use
`taraba update --check` to compare installed assets with a previous build, and
`taraba update` to regenerate Wasm/JS/TS using its saved options. Check is
read-only and exits nonzero for a different version or asset hash; it does not
query crates.io. `--out-dir` selects an output other than pkg. Failed updates
keep the previous output. The local `.taraba/rebuild.json` recipe is excluded
from npm; old outputs or relocated projects need one explicit `taraba build`.
Rust dependencies remain governed by Cargo.toml/Cargo.lock and must match the
CLI's compatibility line (0.x minor, 0.0.x patch, exact prereleases; 1.x+ major).
Update does not change dependency requirements, bump the application's npm version
or publish. See the guide for raw Wasm and compatibility-line migrations.

Use `taraba build --watch` to watch a Cargo project and its WIT/local path dependencies. It runs Cargo release builds for wasm32-unknown-unknown, then regenerates the selected output. Core JSPI/Future is detected after compilation; pass `--component` for Component output; npm options work in watch mode too. Select workspace packages with `--manifest-path` / `--package`, and features with `--features` / `--no-default-features`. WIT defaults to the selected package's `wit/` directory. Custom target and library names are read from Cargo artifact messages.

Builds are serialized and debounced; edits during a build are queued. The output directory is reserved for generated files and is replaced only after successful generation. Failed builds keep the previous output and retry after edits. Cargo's target directory, generated output and dependency caches are excluded from monitoring. Stop with Ctrl-C. With a positional input (`taraba build input.wasm --wit wit --watch`), only Wasm/WIT regeneration is watched; Cargo compilation stays with the external build process.

Requires Rust's wasm32-unknown-unknown target and Binaryen 133. Component builds also need wasm-tools 1.245.1 (`--wasm-tools` selects its path). Component npm builds need Node.js 24+ and jco 1.39.0 (`--jco` selects its path). Core JS assets are embedded: no checkout, Node/esbuild, or jco is needed to build Core artifacts. JSPI needs wasm-opt; Future also needs wasm-as, wasm-merge and wasm-metadce. Set TARABA_BINARYEN or --binaryen for a non-PATH installation.

JavaScript async targets Safari 27+ / JSPI-capable V8; real Safari execution is unverified. Default Core/JSPI serializes instance entry including I/O, treats reject/trap as fatal, and provides no arbitrary Future executor or cancellation. The Future profile has its own ownership/cancellation contract. Native Component async follows the Component toolchain contract; it is not an implementation of the Core runtime. The scaffold does not supply WASI implementations or Preview 1 adapters.

See the [English guide](https://github.com/mizchi/taraba/blob/main/docs/guide.md), [日本語ガイド](https://github.com/mizchi/taraba/blob/main/docs/guide.ja.md), and [Core runtime reference](https://github.com/mizchi/taraba/blob/main/docs/core-runtime.md).

MIT. The optional taraba-allocator is separately licensed MPL-2.0.

Generated npm packages retain MIT/MPL notices and versioned allocator source links.
The application license is separate; update the notice for modified or different
MPL-covered dependencies. See [license provenance](https://github.com/mizchi/taraba/blob/main/THIRD_PARTY.md).
