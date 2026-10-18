# taraba

English | [日本語](README.ja.md)

Formerly named `kanimiso`. The crates, CLI, generated files, and WIT namespaces now use `taraba`.

A small Rust/Wasm runtime for JavaScript hosts. This experimental project targets **Safari 27+ and JSPI-capable V8**. Safari 27 support is documented in [WebKit’s announcement](https://webkit.org/blog/18325/webkit-features-for-safari-27-0/#webassembly).

**WIT** defines application contracts and official **wit-bindgen** generates Rust types, Guest traits, and imports/exports. JSPI is the default execution backend; Future support is opt-in:

- **JSPI scalar** (default; `--jspi` is an explicit alias): native Promises suspend and resume synchronous WIT calls through the engine. This small configuration has no Rust executor or task pool.
- **Future** (`--future`): the existing `spawn_local`, Rust Future, Promise awaiting, and cancellation runtime, supporting `std` and `no_std + alloc`. JS objects stay in the host.

Their Core lowering is distinct from the Component Model Canonical ABI. See the [measurements](docs/wit-comparison.md), including standard Component native async, and the [engine baseline](docs/engine-baseline.md).

A separate [experimental adapter](experiments/jspi-future/README.md) drives Rust Futures through JSPI. The intended extension is optional Future support on top of JSPI. This adapter is still experimental and is not part of the product API. The existing Future backend remains available until concurrency, cancellation/Drop, and concurrent memory/performance gates pass; see the [adoption decision](docs/jspi-adoption.md).

## Install and use

The first crates.io releases of `taraba`, `taraba-allocator`, and `taraba-cli` are being prepared. The following is the intended workflow after publication. Registry installation has not yet been verified; no registry publish has been performed.

```sh
rustup target add wasm32-unknown-unknown
cargo install taraba-cli --version 0.1.0 --locked
# Install Binaryen 133: wasm-opt, wasm-as, wasm-merge, wasm-metadce on PATH
taraba new hello --no-std
cd hello
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/hello.wasm --wit wit --out-dir pkg
```

The native CLI embeds ready-to-use JS and the intrusive pool WAT. Consumers do not need a repository checkout, Node, or esbuild to generate the host. Binaryen is an external prerequisite. Use `TARABA_BINARYEN=/path/to/bin` or `--binaryen /path/to/bin` instead of PATH if desired.

`new` generates an independent Cargo application with registry version dependencies. Its example uses a 64 KiB stack and a 1 MiB memory limit, adjustable in `.cargo/config.toml`. The JSPI example depends only on wit-bindgen and the allocator. For the Future configuration in an existing application, add these dependencies and use `export_runtime!()`:

```sh
cargo add taraba@0.1.0 --no-default-features
cargo add taraba-allocator@0.1.0 --no-default-features
cargo add wit-bindgen@=0.58.0 --no-default-features --features macros
```

Omit `--no-std` to generate a std application. Use `--future` on both `new` and `build` for the existing Future configuration. Existing Future build commands must add this flag; the WIT contract is never used to silently select a backend. `--jspi` remains accepted and cannot be combined with `--future`. The application selects its global allocator. `taraba-allocator` is the MPL-2.0 fork derived from `wee_alloc`, renamed from the experimental `wee-port`. Disable size classes for the smallest configuration.

Deploy `pkg/app.wasm` with its matching `pkg/taraba.mjs`. In a browser, fetch the Wasm as an ArrayBuffer. In Node.js:

```js
import { readFile } from 'node:fs/promises';
import { instantiate } from './pkg/taraba.mjs';

const host = await instantiate(await readFile('./pkg/app.wasm'), {
  bindings: { add: async (a, b) => (a + b) | 0 },
});
console.log(await host.promise('run', 20, 21)); // 42: await add(20,21), await add(41,1)
```

`--debug` emits JS with descriptive errors. Release JS uses short error codes; `pkg/error-codes.json` explains them offline. The output also includes type declarations and build metadata.

## JSPI scalar WIT and execution contract

```wit
package example:app@0.1.0;
world app {
  import add: func(a: s32, b: s32) -> s32;
  export run: func(a: s32, b: s32) -> s32;
}
```

Rust calls synchronous functions. `WebAssembly.Suspending` waits for the Promise returned by `bindings.add`, and `WebAssembly.promising` exposes guest exports as Promises. Supported boundaries are s32/u32/f64 and functions without results. Resources, strings, lists, records, and native WIT async are outside this small profile.

Guest entry, including I/O waits, is serialized per instance: a slow call blocks later calls on that instance. This protects LLVM's linear-memory stack across suspension. Bindings must not await re-entry into the same instance. This profile does not provide cancellation or an executor for arbitrary Rust Futures. A host rejection or Wasm trap permanently closes the instance with the first reason and rejects queued calls with that same reason. Rust Drop is not assumed to run when a JS exception exits Wasm.

Missing JSPI fails with `RT15`; no compatibility fallback is used. Both `host.call` and `host.promise` return Promises. The emitted `taraba.d.mts` describes this profile's API.

## Future WIT and ownership

Use `taraba new hello --no-std --future` and `taraba build ... --wit wit --future` for the optional existing Future profile. It can advance independent tasks while another task waits for I/O. Its WIT imports `resource promise` and defines `add: func(a:s32,b:s32)->promise` and `run: func(a:s32,b:s32)->promise`.

The Future profile supports s32, u32, f64, and own/borrow handles to imported resources whose objects live in JS. Borrow is supported only for import arguments. Unsupported string/list/record types, exported resources, and native WIT async fail the build. Core resources require a non-undefined JS value; a `promise` import must return a Promise. A synchronous boundary returning that resource connects to Rust async internally. Provide application imports through `bindings`; duplicate function names across imported interfaces are rejected.

Converting generated resource handles to `JsPromise` is valid only within this Core profile. These are not canonical resource-table handles usable unchanged with Component hosts. Raw pointers, root IDs, and `rt_*` are private ABI. Invoke application exports through the host's guarded `call` / `promise` methods.

## Verification and limits

The target is one JS agent and non-shared wasm32 memory. The Future profile requires `alloc`; its fixed pool has 1,024 × 128 B slots and limits Future size/alignment. JS roots retain references without copying object data into linear memory. A fatal error stops the instance with the first error and clears JS roots; Rust Drop is never retried after a trap.

Verification covers V8, the system JavaScriptCore shell, and local workerd. The JSC shell is supplied with queueMicrotask via a Promise job. The old local system JSC is classified outside the JSPI baseline. The JSPI std/no_std builds also pass the 3,507 common cases and two controlled suspensions on local workerd. Safari 27 browser execution and Cloudflare production deployment remain unverified. Tests for js-string, exnref, typed funcref, and GC do not imply that the runtime uses all those features. Kani verifies selected native 64-bit models and components, not the JS engine or the complete Wasm runtime.

Historical extraction results are in [verification.md](docs/verification.md) and [JSON](docs/verification.json); [provenance.json](provenance.json) records their origins. Hashes and sizes from before relocation are not presented as current measurements.

## Contributing

```sh
git clone https://github.com/mizchi/taraba.git
cd taraba
just setup
just check
just package-check  # unpack/install .crate archives; run an external std/no_std consumer
just compare-wit
just modern
just stress 60
just workers
just miri
just kani
```

Requires Node.js 24+, pnpm, Rust, and just. The WIT comparison also requires `wasm-tools 1.245.1` (`cargo install wasm-tools --version 1.245.1 --locked`). Before first publication, `package-check` patches registry dependencies to unpacked `.crate` archives. This validates package contents and the consumer workflow, not installation from crates.io. It does not publish to crates.io or npm.

Runtime, CLI, and JS: MIT. Allocator: MPL-2.0. See [THIRD_PARTY.md](THIRD_PARTY.md).
