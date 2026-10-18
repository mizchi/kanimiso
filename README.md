# kanimiso

English | [日本語](README.ja.md)

A small Rust/Wasm async runtime for JavaScript hosts. It connects Rust Futures to native Promises, with `spawn_local`, Promise awaiting, and cancellation. Both `std` and `no_std + alloc` are supported; JavaScript objects stay in the host.

**WIT** defines application contracts and official **wit-bindgen** generates Rust types, Guest traits, and imports/exports. The execution format is **Core Wasm + externref**. Its JS root ownership is a lightweight profile, distinct from the Component Model Canonical ABI. See the [measured comparison](docs/wit-comparison.md) against standard Component async using the same algorithm.

## Install and use

The first crates.io releases of `kanimiso`, `kanimiso-allocator`, and `kanimiso-cli` are being prepared. The following is the intended workflow after publication. Registry installation has not yet been verified; no registry publish has been performed.

```sh
rustup target add wasm32-unknown-unknown
cargo install kanimiso-cli --version 0.1.0 --locked
# Install Binaryen 133: wasm-opt, wasm-as, wasm-merge, wasm-metadce on PATH
kanimiso new hello --no-std
cd hello
cargo build --release --target wasm32-unknown-unknown
kanimiso build target/wasm32-unknown-unknown/release/hello.wasm --wit wit --out-dir pkg
```

The native CLI embeds ready-to-use JS and the intrusive pool WAT. Consumers do not need a repository checkout, Node, or esbuild to generate the host. Binaryen is an external prerequisite. Use `KANIMISO_BINARYEN=/path/to/bin` or `--binaryen /path/to/bin` instead of PATH if desired.

`new` generates an independent Cargo application with registry version dependencies. Its example uses a 64 KiB stack and a 1 MiB memory limit, adjustable in `.cargo/config.toml`. For an existing application, add these dependencies and use the generated example's WIT bindings and `export_runtime!()`:

```sh
cargo add kanimiso@0.1.0 --no-default-features
cargo add kanimiso-allocator@0.1.0 --no-default-features
cargo add wit-bindgen@=0.58.0 --no-default-features --features macros
```

Omit `--no-std` to generate a std application. The application selects its global allocator. `kanimiso-allocator` is the MPL-2.0 fork derived from `wee_alloc`, renamed from the experimental `wee-port`. Disable size classes for the smallest configuration.

Deploy `pkg/app.wasm` with its matching `pkg/kanimiso.mjs`. In a browser, fetch the Wasm as an ArrayBuffer. In Node.js:

```js
import { readFile } from 'node:fs/promises';
import { instantiate } from './pkg/kanimiso.mjs';

const host = await instantiate(await readFile('./pkg/app.wasm'), {
  bindings: { add: async (a, b) => (a + b) | 0 },
});
console.log(await host.promise('run', 20, 21)); // 42: await add(20,21), await add(41,1)
```

`--debug` emits JS with descriptive errors. Release JS uses short error codes; `pkg/error-codes.json` explains them offline. The output also includes type declarations and build metadata.

## WIT scope and ownership

```wit
package example:app@0.1.0;
interface js { resource promise; }
world app {
  import js;
  use js.{promise};
  import add: func(a: s32, b: s32) -> promise;
  export run: func(a: s32, b: s32) -> promise;
}
```

The Core profile supports s32, u32, f64, and own/borrow handles to imported resources whose objects live in JS. Borrow is supported only for import arguments. Unsupported string/list/record types, exported resources, and native WIT async fail the build. Core resources require a non-undefined JS value; a `promise` import must return a Promise. A synchronous boundary returning that resource connects to Rust async internally. Provide application imports through `bindings`; duplicate function names across imported interfaces are rejected.

Converting generated resource handles to `JsPromise` is valid only within this Core profile. These are not canonical resource-table handles usable unchanged with Component hosts. Raw pointers, root IDs, and `rt_*` are private ABI. Invoke application exports through the host's guarded `call` / `promise` methods.

## Verification and limits

The target is one JS agent, non-shared wasm32 memory, `alloc`, and modern JS/Wasm engines. The fixed pool has 1,024 × 128 B slots and limits Future size/alignment. JS roots retain references without copying object data into linear memory. A fatal error stops the instance with the first error and clears JS roots; Rust Drop is never retried after a trap.

Verification covers V8, the system JavaScriptCore shell, and local workerd. The JSC shell is supplied with queueMicrotask via a Promise job. Safari browser execution and Cloudflare production deployment remain unverified. Tests for js-string, exnref, typed funcref, and GC do not imply that the runtime uses all those features. Kani verifies selected native 64-bit models and components, not the JS engine or the complete Wasm runtime.

Historical extraction results are in [verification.md](docs/verification.md) and [JSON](docs/verification.json); [provenance.json](provenance.json) records their origins. Hashes and sizes from before relocation are not presented as current measurements.

## Contributing

```sh
git clone https://github.com/mizchi/kanimiso.git
cd kanimiso
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
