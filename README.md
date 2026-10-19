# taraba

English | [日本語](README.ja.md)

Writing frontend middleware in Rust meant reducing Wasm runtime overhead, including bundle size and async execution.

**taraba is a Rust/Wasm runtime that aims to make that overhead as small as possible, using a dedicated allocator, modern Wasm features, and JavaScript's event loop.**

Build libraries from WIT, including async functions, and distribute them as Components or typed npm packages. A small Core/JSPI backend and the existing Rust Future runtime provide different size/concurrency tradeoffs. Formerly `kanimiso`.

| Need | Execution | Distribution |
|---|---|---|
| WIT async, records, strings, lists, typed domain values | `--component` | Component Model artifact |
| The same API as an npm library with TS declarations | `--component` | add `--npm-name @scope/library` |
| Small numeric JS API (s32/u32/f64) | default / `--jspi` | Core Wasm + JS; npm optional |
| Concurrent Rust Futures, spawn_local and cancellation | `--future` | Core Promise/resource runtime; npm optional |

For WIT-first typed async libraries, choose Component. For size-sensitive numeric APIs, choose JSPI. Set the same execution option on `new` and `build`. Component uses Canonical ABI; Core uses a private JS ABI. npm packaging is independent of this choice.

## Start here

The first crates.io releases are prepared but unpublished. These are the intended post-publication commands; archived crates and external consumers are verified today. See [installation and prerequisites](docs/guide.md#installation).

```sh
cargo install taraba-cli --version 0.1.0 --locked
rustup target add wasm32-unknown-unknown
# Install Binaryen 133 and wasm-tools 1.245.1 for Component builds.
taraba new hello --component --no-std
cd hello
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/hello.wasm --wit wit --component
```

Write `async func` in `wit/app.wit`, implement the generated Rust `Guest` trait with `async fn`, and receive `pkg/app.component.wasm`. Add `--npm-name @example/hello --npm-version 0.1.0 --license MIT` to generate JS, TypeScript, all required Wasm and `package.json`; Component npm builds also need jco 1.39.0. `pnpm pack` produces a tarball. Builds never publish.

During development, `taraba build --watch --component` (`just watch` in the scaffold) watches Rust, WIT and local dependencies, then runs Cargo and regenerates the artifacts. Failed builds keep the previous successful output and retry after edits. See [automatic rebuilds](docs/guide.md#automatic-rebuilds).

<!-- async-size:begin -->
## Build size comparison

The same two-await Rust implementation, std and taraba-allocator (size classes disabled). Uncompressed bytes after JS minification and wasm-opt -Oz on every Wasm. All 34 artifacts pass the same 3,507 cases.

| Backend | Async Wasm B | Async JS B | Total B | Growth from sync B |
|---|---:|---:|---:|---:|
| taraba JSPI | 5,263 | 1,402 | 6,665 | +4,545 |
| taraba Future | 6,871 | 4,007 | 10,878 | +6,153 |
| Embassy WASM + JsFuture | 13,360 | 5,211 | 18,571 | +16,710 |
| wasm-bindgen-futures | 15,221 | 4,442 | 19,663 | +17,802 |
| Tokio current-thread + LocalSet | 52,721 | 4,442 | 57,163 | +55,302 |
| async-executor LocalExecutor | 32,324 | 4,442 | 36,766 | +34,905 |
| async-std spawn_local | 17,930 | 4,442 | 22,372 | +20,511 |
| FuturesUnordered task set | 18,495 | 4,440 | 22,935 | +21,074 |
| Component + jco | 25,350 | 66,776 | 92,126 | +38,986 |

Contracts differ: JSPI serializes an instance; Component includes typed WIT async and Canonical ABI. FuturesUnordered is a task-collection reference. The Component container is not counted again alongside its runtime cores. See [added scheduler configurations, no_std, compression, wee_alloc controls and methodology](docs/async-size.md).
<!-- async-size:end -->

## Documentation

- [Usage guide](docs/guide.md): installation, WIT/Rust async, domain model example, Node/browser loading, TS, npm and daily workflow.
- [Core API reference](docs/core-runtime.md): JSPI/Future contracts, ownership, task limits and errors.
- [Sharing the JS runtime](docs/esm-cache.md): one ESM chunk for multiple Core libraries, with independent instance state.
- [Current async size comparison](docs/async-size.md): taraba, Embassy, Tokio, async-executor, async-std, wasm-bindgen-futures and a FuturesUnordered reference; sync-to-async growth and all runtime JS/Wasm counted.
- [Documentation index](docs/README.md): earlier measurements and experiments.
- [Development and verification](docs/development.md): tests, package checks and reproduction commands.

JavaScript async targets Safari 27+ / JSPI-capable V8. Real Safari and native Component-host execution are unverified here. Component async/jco remains experimental upstream. JSPI serializes an instance across I/O and treats reject/trap as fatal; it is not a general Rust Future executor. These contracts differ from the optional Future runtime and the standard Component toolchain.

CLI/runtime/JS: MIT. Optional allocator: MPL-2.0. [Third-party sources and licenses](THIRD_PARTY.md).
