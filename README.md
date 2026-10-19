# taraba

English | [日本語](README.ja.md)

**An async runtime and allocator for Rust, optimized for a small WebAssembly footprint.**

<p align="center">
  <img src="docs/assets/taraba.png" alt="taraba mascot" width="256">
</p>

Build frontend middleware in Rust with less Wasm and JavaScript to ship. taraba uses a dedicated `taraba-allocator`, modern Wasm features, and JavaScript's Promises and event loop for async execution. Supports std and no_std.

Optional [`taraba-helpers`](docs/helpers.md) borrow JavaScript regex and string APIs. String helpers emit the operations you use and their shared infrastructure; unused helpers add 0 B of JS.

## Minimal example

**JSPI (JavaScript Promise Integration)** is an engine feature that suspends Wasm execution and resumes it at the same point when a JS Promise settles. taraba uses it by default: Rust calls JS async functions, and JavaScript callers receive results with `await`. The JS event loop remains free while Wasm waits. See [how JSPI works](https://v8.dev/blog/jspi).

With Rust 1.85 or later, install the CLI and Wasm target, then create a project. Put the Binaryen 133 tools on PATH for builds. See [installation details](docs/guide.md#installation).

```sh
cargo install taraba-cli --version 0.1.0 --locked
rustup target add wasm32-unknown-unknown

taraba new hello
cd hello
```

Define the imported JS function and public API in `wit/app.wit`:

```wit
package taraba:app@0.1.0;
world app {
    import add: func(a: s32, b: s32) -> s32;
    export run: func(a: s32, b: s32) -> s32;
}
```

Implement `src/lib.rs`, keeping the scaffold's allocator configuration and panic handler:

```rust
wit_bindgen::generate!({ path: "wit", world: "app" });

struct App;
impl Guest for App {
    fn run(a: i32, b: i32) -> i32 {
        let first = add(a, b); // JSPI suspends until the JS Promise resolves
        add(first, 1)
    }
}
export!(App);
```

Rust functions use synchronous syntax; JSPI handles Promise suspension. `taraba build` runs Cargo in release mode for wasm32-unknown-unknown, optimizes the Wasm and generates JS and TypeScript declarations. Defaults are `Cargo.toml`, `wit/` and output in `pkg/`.

```sh
taraba build
```

The output is a complete npm directory in `pkg/`:

```text
pkg/
├── index.js          # ESM entry exporting createHost
├── index.d.ts        # WIT-derived declarations
├── app.wasm
├── runtime.mjs
├── runtime.d.mts
├── package.json
└── wit/
```

The package name, version and license come from the selected Cargo package.
A missing license becomes `UNLICENSED`. Override fields independently with
`--npm-name @scope/library`, `--npm-version` and `--license`.

Run `pnpm pack` inside `pkg/` to create a tarball, or `pnpm publish --access public`
there when ready to publish. `taraba build` never publishes.
See [package output](docs/guide.md#generated-npm-package).

Save this as `main.mjs` and run `node main.mjs` with Node.js 24+:

```js
import { readFile } from 'node:fs/promises';
import { createHost } from './pkg/index.js';

const host = createHost({
    bindings: { add: async (a, b) => (a + b) | 0 },
});
const { instance } = await WebAssembly.instantiate(
    await readFile(new URL('./pkg/app.wasm', import.meta.url)),
    host.imports,
);
host.attach(instance.exports);
console.log(await host.run(20, 21)); // Promise<number> → 42
```

`taraba build` generates `AppBindings` and `AppHost` from WIT, including callback arguments and results. TypeScript and JS editors infer `a`, `b` and `host.run(...)`; unknown methods and incorrect arguments are type errors. The npm entry exposes the same API.

Standard `WebAssembly.instantiate` handles loading and instantiation. taraba supplies imports and guarded calls. Attach one instance per host, and call WIT exports directly, for example `host.run(a, b)`.

Use `taraba build --watch` during development to watch Rust, WIT and local dependencies, running Cargo compilation and artifact generation automatically.

After upgrading the CLI, use `taraba update --check` to detect changed embedded
assets and `taraba update` to regenerate Wasm/JS/TS with the previous build
options. Failed updates retain the previous output. See [asset updates](docs/guide.md#updating-generated-assets).

## When do I need JSPI or Future?

**Calling JS-provided async functions sequentially from Rust already works with the default JSPI backend.** The sample's `add` does exactly this. Rust functions use synchronous syntax; the Wasm engine suspends and resumes them around Promise waits.

A Rust **Future** is an asynchronous computation that can wait and resume before completing. The Future backend includes taraba's executor to drive these computations. Choose it to bring existing Rust `async fn` / `.await` code, advance multiple Futures concurrently, or explicitly cancel Rust tasks.

| What you need | Choose | Why |
|---|---|---|
| Call JS async functions in sequence and compute with their results | JSPI (default) | The engine handles Promise suspension and resumption |
| Compose Rust Futures with `.await`, join / select, or `spawn_local` | Future | An executor stores and resumes pending Rust tasks |
| Advance another call on the same instance while one call waits for I/O | Future | The JSPI backend serializes an instance, including its I/O waits |
| Cancel Rust tasks or handle Promise failures per task | Future | Task lifetimes and `Result` values are managed in Rust |
| Build a typed API with WIT `async func`, records, strings and lists | `--component` | Uses the standard Component Model with wit-bindgen / jco |

Both JSPI and Future support std and no_std. A host rejection or Wasm trap closes a JSPI instance. Future tasks have size/count limits; cancelling a task does not automatically abort host network I/O. See [contracts and limits](docs/core-runtime.md).

`taraba new app --future` scaffolds the Future API. Subsequent `taraba build` / `taraba build --watch` select JSPI/Future from the compiled runtime imports/exports and WIT resources, rather than `async` / `Future` keywords in Rust source. `--jspi` / `--future` force a Core profile; `--component` selects Component output. Core builds produce an npm directory by default; `--npm-name @scope/library` overrides its name. Component npm output requires `--npm-name`. Component npm output uses jco to generate JS / TS. See the [usage guide](docs/guide.md).

## How small?

Each configuration uses the same Rust implementation with two Promise waits and additions, and passes the same 3,507 cases. All use taraba-allocator with size classes disabled. Uncompressed sizes after wasm-opt -Oz and JS minification; 1 kB = 1,000 bytes.

| Backend | taraba execution option | Rust | Wasm kB | JS kB | Total kB |
|---|---|---|---:|---:|---:|
| taraba JSPI | Auto (override: `--jspi`) | std | 5.227 | 1.095 | **6.322** |
| taraba JSPI | Auto (override: `--jspi`) | no_std | 0.248 | 1.095 | **1.343** |
| taraba Future | Auto (override: `--future`) | std | 6.803 | 3.629 | **10.432** |
| taraba Future | Auto (override: `--future`) | no_std | 1.712 | 3.629 | **5.341** |
| Component + jco | `--component` | std | 25.314 | 66.776 | **92.090** |
| Component + jco | `--component` | no_std | 13.691 | 66.776 | **80.467** |
| wasm-bindgen-futures | — | std | 15.185 | 4.442 | **19.627** |
| wasm-bindgen-futures | — | no_std | 9.783 | 4.442 | **14.225** |

Core execution is selected automatically at build time. Use `taraba build --component` for Component output. std is the default; select no_std with `taraba new --no-std`. Component + jco measures the JS-facing npm output (add `--npm-name`), counting every required core Wasm and JS file. See the [full measurements](docs/async-size.md#npm-and-component-payloads) for standalone Component sizes.

These benchmark fixtures perform the same computation as the minimal example. The values are whole application sizes, rather than fixed runtime costs. JSPI, Future and Component have different concurrency and error contracts.

Builds warn about formatting macros such as `format!` / `write!`. Run `taraba build --insight`, then `taraba insight --paths fmt` to inspect optimized function sizes and keeping paths. See [size inspection](docs/insight.md).

<details>
<summary>Full runtime breakdown and measurement conditions</summary>

<!-- async-size:begin -->
## Build size comparison

The same two-await Rust implementation, std and taraba-allocator (size classes disabled). Uncompressed bytes after JS minification and wasm-opt -Oz on every Wasm. All 34 artifacts pass the same 3,507 cases.

| Backend | Async Wasm B | Async JS B | Total B | Growth from sync B |
|---|---:|---:|---:|---:|
| taraba JSPI | 5,227 | 1,095 | 6,322 | +4,545 |
| taraba Future | 6,803 | 3,629 | 10,432 | +6,121 |
| Embassy WASM + JsFuture | 13,324 | 5,211 | 18,535 | +16,710 |
| wasm-bindgen-futures | 15,185 | 4,442 | 19,627 | +17,802 |
| Tokio current-thread + LocalSet | 52,689 | 4,442 | 57,131 | +55,306 |
| async-executor LocalExecutor | 32,288 | 4,442 | 36,730 | +34,905 |
| async-std spawn_local | 17,894 | 4,442 | 22,336 | +20,511 |
| FuturesUnordered task set | 18,459 | 4,440 | 22,899 | +21,074 |
| Component + jco | 25,314 | 66,776 | 92,090 | +38,986 |

Contracts differ: JSPI serializes an instance; Component includes typed WIT async and Canonical ABI. FuturesUnordered is a task-collection reference. The Component container is not counted again alongside its runtime cores. See [added scheduler configurations, no_std, compression, wee_alloc controls and methodology](docs/async-size.md).
<!-- async-size:end -->

</details>

## Use only the JavaScript builtins you need

`taraba-helpers` is optional. It borrows the JS engine's regex and Unicode implementations to reduce Wasm size. Add it from crates.io (Rust 1.85+):

```toml
[dependencies]
taraba-helpers = { version = "0.1.0", features = ["strings"] }
```

```rust
use taraba_helpers::string::JsString;

fn utf16_units(input: &str) -> u32 {
    JsString::from(input).utf16_len()
}
```

Run `taraba build` as usual. Cargo features enable Rust APIs. The build selects individual string, Iterator, Segmenter and Decoder operations from imports remaining after wasm-opt. Unused helpers add **0 B of JS**.

| Task | Feature | Included operations |
|---|---|---|
| Read a string's length | `strings` | UTF-8 input, UTF-16 length and root release; excludes normalization, casing and TextEncoder |
| Normalize text | `strings` | Input and normalization; UTF-8 output only when using `write_utf8` or another output API |
| Count segments | `segmenter` | Input, segmentation and Iterator; excludes segment text/index/word-like accessors |
| Decode text | `encoding` | The requested encoding's Decoder and the string operations you use |

Using host strings also includes shared root infrastructure. This is a common cost for the first string feature, rather than a separate charge for every API. Supports std/no_std and Core JSPI/Future. Application WIT and `host.method(...)` stay the same; no manual JS bindings are needed.

The [string/Iterator guide and size table](docs/strings.md) separate Wasm, generated JS and Rolldown output. These helpers target Core with a JS host; Component and JS-free WASI hosts are not supported.

## Why

Frontend libraries become dependencies of other libraries, often deep in an application's dependency graph. Adding tens of kB of runtime to a small piece of functionality can make it too expensive to adopt. Overhead an application can afford may rule out a reusable middleware library.

taraba aims to make Rust code small enough to choose as a frontend dependency. For context, these small usage examples of familiar JS libraries were measured with the same Rolldown setup.

| Library | Version | Measured usage | Minified kB | Minified + gzip kB |
|---|---|---|---:|---:|
| React (core) | 19.3.1 | createElement / useState; no renderer | 1.916 | 0.934 |
| React + React DOM | 19.3.1 | Render a span into the DOM | 220.025 | 67.524 |
| Preact | 11.0.1 | Render a span into the DOM | 10.598 | 4.535 |
| Zod | 4.6.7 | Validate `{ name: string }` | 83.101 | 22.759 |
| Hono | 4.13.13 | One GET route | 18.228 | 7.410 |
| Valibot | 1.5.0 | Validate `{ name: string }` | 2.909 | 1.169 |

Measured on 2026-10-19 with Rolldown 1.2.14, production / ES2022 / ESM, gzip level 9. These are small usage entries, rather than whole packages or an equivalent-functionality performance comparison. Use the uncompressed minified column when comparing with the taraba table above. See [sources, conditions and reproduction](docs/frontend-size.md).

**JSPI uses roughly 1.1 kB of JS, most of which is runtime code that can be shared across taraba libraries.** Deduplicate identical-profile runtimes into one ESM chunk at one URL, and the code is loaded and evaluated once. Default package-local copies need [explicit Rolldown deduplication](docs/esm-cache.md). The table's 1.095 kB includes an application wrapper; the shareable runtime alone measures 0.975 kB in the separate ESM experiment. Application wrappers, Wasm and instance state remain separate.

The shared runtime exports only `createHost`. `index.js` generates the typed application methods; native WebAssembly APIs handle instantiation.

**When JS supplies I/O such as networking and timers, and Rust handles computation, validation or transformation, start with no_std.** With [`alloc`](https://doc.rust-lang.org/stable/alloc/) and an allocator, no_std still supports `Vec`, `String` and `Box`, as well as the Future backend. Middleware logic need not link std unless its dependencies require it. The two-addition benchmark fixture has 248 B of Wasm with no_std + JSPI, allowing small additions once the common JS is delivered. Actual application logic, dependencies and used allocator code add to this size.

no_std does not expand the boundary's supported types. Core/JSPI currently accepts numeric APIs (s32/u32/f64). Choose the typed Component backend to pass strings, records or lists directly across the public API.

`taraba-allocator` is also usable on its own: a small allocator derived from wee_alloc, with configurations for minimum size or frequent small allocations. See [allocator configuration and comparisons](docs/guide.md#choose-an-allocator-profile).

## Documentation

- [Usage guide](docs/guide.md): installation, WIT/Rust async, domain model example, Node/browser loading, TS, npm and daily workflow.
- [Core API reference](docs/core-runtime.md): JSPI/Future contracts, ownership, task limits and errors.
- [Error codes](docs/error-codes.md): causes and recovery for runtime errors.
- [Sharing the JS runtime](docs/esm-cache.md): one ESM chunk for multiple Core libraries, with independent instance state.
- [Current async size comparison](docs/async-size.md): taraba, Embassy, Tokio, async-executor, async-std, wasm-bindgen-futures and a FuturesUnordered reference; sync-to-async growth and all runtime JS/Wasm counted.
- [Documentation index](docs/README.md): earlier measurements and experiments.
- [Development and verification](docs/development.md): tests, package checks and reproduction commands.

JavaScript async targets Safari 27+ / JSPI-capable V8. Real Safari and native Component-host execution are unverified here. Component async/jco remains experimental upstream. JSPI serializes an instance across I/O and treats reject/trap as fatal; it is not a general Rust Future executor. These contracts differ from the optional Future runtime and the standard Component toolchain.

CLI/runtime/JS: MIT. Optional allocator: MPL-2.0. [Third-party sources and licenses](THIRD_PARTY.md).

Generated npm packages retain MIT/MPL notices and versioned allocator source links.
The application license is separate; update the notice for modified or different
MPL-covered dependencies. See [license provenance](https://github.com/mizchi/taraba/blob/main/THIRD_PARTY.md).
