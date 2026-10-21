# taraba

English | [日本語](README.ja.md)

**An async runtime and allocator for Rust/WebAssembly, optimized to minimize runtime size.**

<p align="center">
  <img src="docs/assets/taraba.png" alt="taraba mascot" width="256">
</p>

Build frontend middleware in Rust with less Wasm and JavaScript to ship. taraba uses a dedicated `taraba-allocator`, modern Wasm features, and JavaScript's Promises and event loop for async execution. Supports std and no_std.

Optional [`taraba-helpers`](docs/helpers.md) borrow JavaScript regex and string APIs.

## Minimal example

Write Rust `async` / `.await` code that calls JavaScript async functions, then expose it as a typed npm package. Promise waits leave the JS event loop free.

Requires Rust 1.85 or later and Binaryen 133 on PATH. Install the CLI from crates.io; generated projects use matching Rust crates. See [installation](docs/guide.md#installation).

```sh
cargo install taraba-cli --version 0.2.0 --locked
rustup target add wasm32-unknown-unknown

taraba new hello --future
cd hello
```

Define the imported JS function and public API in `wit/app.wit`. The result type `future<s32>` describes the Promise's payload:

```wit
package taraba:app@0.1.0;
world app {
    import add: func(a: s32, b: s32) -> future<s32>;
    export run: func(a: s32, b: s32) -> future<s32>;
}
```

The scaffold's `build.rs` generates the `Guest` trait and import functions from WIT. Implement them in `src/lib.rs`, keeping the scaffold's allocator and panic handler:

```rust
include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
bindings!();

struct App;
impl Guest for App {
    async fn run(a: i32, b: i32) -> HostResult<i32> {
        let first = add(a, b).await?;
        add(first, 1).await
    }
}
export!(App);
```

`HostResult` propagates rejected host Promises as Rust errors. JavaScript receives `run` as `Promise<number>`. `taraba build` regenerates bindings, runs Cargo in release mode for wasm32-unknown-unknown, optimizes the Wasm and generates JS and TypeScript declarations. Defaults are `Cargo.toml`, `wit/` and output in `pkg/`.

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
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createHost } from "./pkg/index.js";

const host = createHost({
  bindings: {
    add: async (a, b) => {
      await delay(1);
      return (a + b) | 0;
    },
  },
});
const { instance } = await WebAssembly.instantiate(
  await readFile(new URL("./pkg/app.wasm", import.meta.url)),
  host.imports,
);
host.attach(instance.exports);
console.log(await host.run(20, 21)); // 42
```

`taraba build` generates `AppBindings` and `AppHost` from WIT, including callback arguments and results. TypeScript and JS editors infer `a`, `b` and `host.run(...)`; unknown methods and incorrect arguments are type errors. The npm entry exposes the same API.

Standard `WebAssembly.instantiate` handles loading and instantiation. taraba supplies imports and guarded calls. Attach one instance per host, and call WIT exports directly, for example `host.run(a, b)`.

Use `taraba build --watch` during development to watch Rust, WIT and local dependencies, running Cargo compilation and artifact generation automatically.

After upgrading the CLI, use `taraba update --check` to detect changed embedded
assets and `taraba update` to regenerate Wasm/JS/TS with the previous build
options. Failed updates retain the previous output. See [asset updates](docs/guide.md#updating-generated-assets).

## How small?

<!-- async-size:begin -->
Each configuration compiles the same Rust implementation with two Promise waits and additions, and passes the same 3,507 cases. All use taraba-allocator with size classes disabled. Uncompressed sizes after wasm-opt -Oz and JS minification; 1 kB = 1,000 bytes.

![Size comparison by std and no_std. Orange is Wasm, blue is JS; taraba, wasm-bindgen-futures, Embassy and wit-bindgen async use the same scale.](docs/assets/async-size.svg)

<details>
<summary>View the numbers as a table</summary>

| Configuration | Rust | Wasm kB | JS kB | Total kB |
|---|---|---:|---:|---:|
| taraba JSPI | std | 5.227 | 1.209 | **6.436** |
| taraba JSPI | no_std | 0.248 | 1.209 | **1.457** |
| taraba Future | std | 6.640 | 3.695 | **10.335** |
| taraba Future | no_std | 1.575 | 3.695 | **5.270** |
| wasm-bindgen-futures | std | 15.185 | 4.478 | **19.663** |
| wasm-bindgen-futures | no_std | 9.783 | 4.478 | **14.261** |
| Embassy WASM + JsFuture | std | 13.324 | 5.242 | **18.566** |
| wit-bindgen async + jco | std | 21.871 | 66.825 | **88.696** |
| wit-bindgen async + jco | no_std | 11.236 | 66.825 | **78.061** |

</details>

taraba JSPI uses engine-managed Promise waits; taraba Future runs Rust `async` / `.await`. `taraba build` detects the configuration from the compiled Wasm. The example above uses Future. std is the default; create a no_std scaffold with `taraba new hello --future --no-std`.

wit-bindgen async is the standard Component configuration: WIT `async func` generates Rust `async fn` / Futures. Unused `async-spawn` is disabled; totals include the jco bridge required to execute it in JavaScript.

Embassy uses its official WASM event-loop integration and wasm-bindgen-futures JsFuture. This configuration links std, so no no_std value is listed. These are whole application sizes. JSPI serializes an instance; executors differ in concurrency, errors and task capacity. See [all runtime measurements, compression, wee_alloc controls and methodology](docs/async-size.md).
<!-- async-size:end -->

See the [rich async comparison](docs/rich-async-size.md) for records, strings, byte arrays and Result: the same Rust workflow and shared tests against standard wit-bindgen async, with deployed size, execution time and memory measured separately.

Builds warn about formatting macros such as `format!` / `write!`. Run `taraba build --insight`, then `taraba insight --paths fmt` to inspect optimized function sizes and keeping paths. See [size inspection](docs/insight.md).

## Use only the JavaScript builtins you need

`taraba-helpers` is optional. It borrows the JS engine's regex and Unicode implementations to reduce Wasm size. Add it from crates.io (Rust 1.85+):

```toml
[dependencies]
taraba-helpers = { version = "0.2.0", features = ["strings"] }
```

```rust
use taraba_helpers::string::JsString;

fn utf16_units(input: &str) -> u32 {
    JsString::from(input).utf16_len()
}
```

Run `taraba build` as usual. Cargo features enable Rust APIs. The build selects individual string, Iterator, Segmenter and Decoder operations from imports remaining after wasm-opt. Unused helpers add **0 B of JS**.

| Task                   | Feature     | Included operations                                                                         |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| Read a string's length | `strings`   | UTF-8 input, UTF-16 length and root release; excludes normalization, casing and TextEncoder |
| Normalize text         | `strings`   | Input and normalization; UTF-8 output only when using `write_utf8` or another output API    |
| Count segments         | `segmenter` | Input, segmentation and Iterator; excludes segment text/index/word-like accessors           |
| Decode text            | `encoding`  | The requested encoding's Decoder and the string operations you use                          |

Using host strings also includes shared root infrastructure. This is a common cost for the first string feature, rather than a separate charge for every API. Supports std/no_std and Core JSPI/Future. Application WIT and `host.method(...)` stay the same; no manual JS bindings are needed.

The [string/Iterator guide and size table](docs/strings.md) separate Wasm, generated JS and Rolldown output. These helpers target Core with a JS host; Component and JS-free WASI hosts are not supported.

## Why

Both [`wee_alloc`](https://github.com/rustwasm/wee_alloc) and [`console_error_panic_hook`](https://github.com/rustwasm/console_error_panic_hook), familiar pieces of the Rust/Wasm stack, were archived in August 2025. That prompted taraba: a small async runtime, allocator and panic reporting built around modern Wasm features and JavaScript's event loop. The allocator adapts wee_alloc; release errors use compact codes, with detailed diagnostics kept in debug builds.

Frontend libraries become dependencies of other libraries, often deep in an application's dependency graph. Adding tens of kB of runtime to a small piece of functionality can make it too expensive to adopt. Overhead an application can afford may rule out a reusable middleware library.

For scale, small usage examples measured with Rolldown produce about 2.9 kB for Valibot, 10.6 kB for Preact and 18.2 kB for Hono, minified and uncompressed. taraba aims to make Rust practical at this scale. See [full measurements, including React and Zod, and conditions](docs/frontend-size.md).

**The JS runtime can be shared across taraba libraries.** Deduplicate identical-profile runtimes into one ESM chunk at one URL, and the code is loaded and evaluated once. Default package-local copies need [explicit Rolldown deduplication](docs/esm-cache.md). The comparison table includes application wrappers; [shared-runtime sizes](docs/esm-cache.md#measurement-and-reproduction) are measured separately. Application wrappers, Wasm and instance state remain separate.

The shared runtime exports only `createHost`. `index.js` generates the typed application methods; native WebAssembly APIs handle instantiation.

**When JS supplies I/O such as networking and timers, and Rust handles computation, validation or transformation, start with no_std.** With [`alloc`](https://doc.rust-lang.org/stable/alloc/) and an allocator, no_std still supports `Vec`, `String` and `Box`, as well as the Future backend. Middleware logic need not link std unless its dependencies require it. The two-addition benchmark fixture has 248 B of Wasm with no_std + JSPI, allowing small additions once the common JS is delivered. Actual application logic, dependencies and used allocator code add to this size.

Core/JSPI accepts numeric APIs (s32/u32/f64). Core Future also generates typed bindings for strings, records, lists and other [WIT value types](docs/core-runtime.md#value-types-and-selective-code-generation), including async payloads. Only used codecs are deployed; the shared runtime is unchanged. [TypeScript interop: named types, readonly inputs and TypedArray](docs/typescript.md). Choose Component for standard Canonical ABI interoperability.

`taraba-allocator` is also usable on its own: a small allocator derived from wee_alloc, with configurations for minimum size or frequent small allocations. See [allocator configuration and comparisons](docs/guide.md#choose-an-allocator-profile).

## Documentation

- [Current capabilities and limits](docs/status.md): supported types, async/lifecycle contracts, distribution and verification boundaries.
- [Usage guide](docs/guide.md): installation, WIT/Rust async, domain model example, Node/browser loading, TS, npm and daily workflow.
- [Core API reference](docs/core-runtime.md): JSPI/Future contracts, ownership, task limits and errors.
- [Error codes](docs/error-codes.md): causes and recovery for runtime errors.
- [Sharing the JS runtime](docs/esm-cache.md): one ESM chunk for multiple Core libraries, with independent instance state.
- [Current async size comparison](docs/async-size.md): taraba, wit-bindgen, wasm-bindgen-futures, Embassy and other executors; sync-to-async growth and all runtime JS/Wasm counted.
- [Documentation index](docs/README.md): earlier measurements and experiments.
- [Development and verification](docs/development.md): tests, package checks and reproduction commands.

JavaScript async targets Safari 27+ / JSPI-capable V8. Real Safari and native Component-host execution are unverified here. See [execution contracts and limits](docs/core-runtime.md).

CLI/runtime/JS: MIT. Optional allocator: MPL-2.0. [Third-party sources and licenses](THIRD_PARTY.md).

Generated npm packages retain MIT/MPL notices and versioned allocator source links.
The application license is separate; update the notice for modified or different
MPL-covered dependencies. See [license provenance](https://github.com/mizchi/taraba/blob/main/THIRD_PARTY.md).
