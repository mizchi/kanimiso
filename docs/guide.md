# Library usage guide

English | [日本語](guide.ja.md)

Build Rust/Wasm libraries from **WIT contracts**, including async functions, and distribute them as Components or typed npm packages. The toolkit also provides a small JSPI backend and an optional Rust Future runtime for JavaScript hosts. Formerly `kanimiso`.

## Choose an execution contract and a distribution format

| Use case | Execution option | Distribution option | What the user writes / receives |
|---|---|---|---|
| A Component Model library for an async-capable component host | `--component` | no npm flag | WIT `async func`, Rust `async fn`; `app.component.wasm` with Canonical ABI |
| An npm library with typed async/domain values | `--component` | `--npm-name @scope/library` | Standard `wit-bindgen` Rust bindings and `jco` JS/TS bindings; records, strings, lists, `result`, typed async results |
| A small browser/JS library with numeric boundaries | default / `--jspi` | `--npm-name @scope/library` | Synchronous Rust imports suspend through JSPI; WIT-derived typed exports, `Promise<number>` |
| Concurrent Rust Future tasks, `spawn_local`, explicit cancellation | `--future` | optionally `--npm-name` | The existing Core Promise/resource runtime; opaque resource payloads are `unknown` in TS |

**Choose Component for WIT-first async application libraries.** Choose Core/JSPI when size is the main constraint and s32/u32/f64 boundaries are sufficient. The CLI's default remains Core/JSPI. Set the same execution option on `new` and `build`; backend selection is explicit.

`--component` uses standard Component Model Canonical ABI. The two Core profiles use a private JS ABI. Component and Core artifacts are different contracts; they are not interchangeable. npm packaging is a separate choice that can be combined with either.

## Generated files and editing workflow

| Location | Role |
|---|---|
| `wit/app.wit` | Public API: change types, imports/exports and async contracts here |
| `src/lib.rs` | Implement the generated Guest; keep domain logic in ordinary Rust modules |
| `Cargo.toml` | std/no_std, allocator, dependencies and release settings |
| `.cargo/config.toml` | Scaffold stack 64 KiB / memory limit 1 MiB; adjust for the application |
| `justfile` | build/npm tasks pinned to the selected execution contract |
| `pkg/` | Generated artifacts; change WIT/Rust and regenerate these files |

Edit WIT, update Guest/imports using Rust's type errors, run cargo build then taraba build, and typecheck/test the consumer. std and no_std have the same interface but different panic/allocator code sizes.

The scaffold's `just build` builds the selected artifact; `just npm @example/orders 0.1.0 MIT` regenerates an npm package. The npm task includes local node_modules/.bin in PATH, so jco can be installed with pnpm add -D.

## Installation

The three crates (`taraba-cli`, `taraba`, `taraba-allocator`) are prepared for their first crates.io release. Registry publication and registry installation have not been performed. The following commands describe the intended workflow after publication; archived crates and external consumers are tested today.

```sh
rustup target add wasm32-unknown-unknown
cargo install taraba-cli --version 0.1.0 --locked
# Install Binaryen 133 and put its tools on PATH.
# --binaryen /path/to/bin or TARABA_BINARYEN can select another location.
```

Component builds also require `wasm-tools 1.245.1`. Component **npm** builds additionally require Node.js 24+ and `@bytecodealliance/jco@1.39.0`; `--jco /path/to/jco` selects the executable. Core builds embed their JS runtime and require neither Node nor jco. No consumer needs this repository checkout or esbuild.

## A WIT-first async Component library

```sh
taraba new orders --component --no-std
cd orders
```

The generated `wit/app.wit` is the public API:

```wit
package taraba:app@0.1.0;
world app {
  import add: async func(a: s32, b: s32) -> s32;
  export run: async func(a: s32, b: s32) -> s32;
}
```

Official `wit-bindgen` generates the Rust types, imports and `Guest` trait. Application code contains no handle conversions or runtime ABI exports:

```rust
wit_bindgen::generate!({ path: "wit", world: "app" });

struct App;
impl Guest for App {
    async fn run(a: i32, b: i32) -> i32 {
        let first = add(a, b).await;
        add(first, 1).await
    }
}
export!(App);
```

The scaffold supplies the allocator, no_std panic handler, async binding features and release settings. Omit `--no-std` for std. Edit WIT and the implementation, then build:

```sh
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/orders.wasm \
  --wit wit --component --out-dir pkg
# Or use the generated justfile: just build
```

`pkg/app.component.wasm` is optimized, encoded and validated, then checked against the selected WIT world. `app.wit` describes the encoded component and `build.json` records its ABI. `--world` selects a world when WIT contains several. The component path preserves Canonical ABI metadata; it never uses Core externref lowering.

Use WIT records/lists/strings/results for domain contracts. Imported interfaces and resource ownership are generated by the standard tools. Native async needs a component host supporting that proposal; this project's library check validates the artifact and executes its jco output, rather than claiming execution on every native component host. The scaffold supplies no ambient WASI implementation or Preview 1 adapter. Provide the component's declared imports at its host boundary.

## Build an npm library, including TypeScript

From the Component project above:

```sh
pnpm add -D @bytecodealliance/jco@1.39.0
taraba build target/wasm32-unknown-unknown/release/orders.wasm \
  --wit wit --component --jco node_modules/.bin/jco \
  --npm-name @example/orders --npm-version 0.1.0 --license MIT --out-dir pkg
cd pkg
pnpm pack
```

This prepares `package.json` with ESM exports, a `types` condition, an explicit `files` list, and all JS/Wasm/type files needed at runtime. jco generates application-specific declarations, including async `Promise<T>` results and domain types. The package also exports the original Component as `@example/orders/component.wasm` and its encoded WIT as `@example/orders/wit`. jco/wasm-tools/taraba are build tools, not runtime dependencies of this package. Build never publishes. `--license` defaults to `UNLICENSED`; choose the application license explicitly for distribution.

A Node consumer installs the tarball (or, after publication, the package) and provides its imports and a core-module loader:

```js
import { readFile } from 'node:fs/promises';
import { instantiate } from '@example/orders';

const base = new URL(import.meta.resolve('@example/orders/package.json'));
const api = await instantiate(
  async name => WebAssembly.compile(await readFile(new URL(name, base))),
  { add: { default: async (a, b) => (a + b) | 0 } },
);
console.log(await api.run(20, 21)); // 42; typed Promise<number>
```

Browser consumers supply a loader that fetches the package's generated core `.wasm` files. Ship every core file; dynamic loader paths are not automatically discovered by all bundlers. Instantiation mode keeps host imports explicit and allows separate instances. See [jco's instantiation contract](https://bytecodealliance.github.io/jco/transpiling.html).

## Domain models and typed async

Replace the Component scaffold's WIT with a domain contract. Interface names and versions are part of the public API:

```wit
package example:orders@0.1.0;
interface domain {
  record order { id: u32, label: string, amounts: list<u32> }
  evaluate: async func(order: order) -> result<order, string>;
}
world app {
  import domain;
  use domain.{order};
  export process: async func(order: order) -> result<order, string>;
}
```

Keep the scaffold's allocator/panic handler and update its bindings/implementation:

```rust
extern crate alloc;
wit_bindgen::generate!({ path: "wit", world: "app" });
struct App;
impl Guest for App {
    async fn process(order: Order) -> Result<Order, alloc::string::String> {
        example::orders::domain::evaluate(order).await
    }
}
export!(App);
```

A TypeScript consumer uses the generated types. Supply the same core-module load callback as in the Node example:

```ts
import { instantiate, type ImportObject } from '@example/orders';

const imports: ImportObject = {
  'example:orders/domain@0.1.0': {
    evaluate: async order => ({ ...order, label: order.label + ' ✓' }),
  },
};
const api = await instantiate(load, imports);
const order = await api.process({
  id: 4294967295,
  label: '注文 🍣',
  amounts: new Uint32Array([1, 2]),
});
const label: string = order.label;
```

jco's ImportObject requires the versioned interface ID. The CLI's npm entry maps it to jco 1.39's runtime alias, so pass the ID from the generated type directly. list<u32> becomes Uint32Array, not number[]. A top-level WIT result becomes a successful JS return or rejection (ComponentError payload). Tests verify that a typed application Err does not poison the instance. This is a different contract from Core/JSPI first-fatal behavior.

`just library-check` verifies these record/string/list/result round trips in std and no_std. The [size comparison](async-size.md) uses numeric two-await functions, not this domain workload.

## Build a smaller numeric npm library

```sh
taraba new tiny --no-std
cd tiny
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/tiny.wasm --wit wit \
  --npm-name @example/tiny --npm-version 0.1.0 --license MIT
```

```js
import { readFile } from 'node:fs/promises';
import { instantiate } from '@example/tiny';

const host = await instantiate(
  await readFile(new URL(import.meta.resolve('@example/tiny/app.wasm'))),
  { bindings: { add: async (a, b) => (a + b) | 0 } },
);
console.log(await host.exports.run(20, 21)); // typed Promise<number>
```

The numeric Core API has `AppBindings`, `AppExports`, and `AppHost` generated from WIT; export names/arguments are checked by TypeScript. Without `--npm-name`, Core builds retain the lower-level `taraba.mjs`/`taraba.d.mts` API. Both formats support debug errors via `--debug`; release uses error codes with an external dictionary.

Core/JSPI serializes each instance across I/O waits; a slow call blocks later calls. Host rejection/trap closes the instance, with no cancellation or Rust Drop guarantee on that path. It does not drive arbitrary Rust Futures or native WIT async. Use `--future` when the existing executor's independent task progress and cancellation are required. Its WIT Promise resource has no payload type, so TS correctly returns `Promise<unknown>`; use Component for WIT-typed async results. See the [Core runtime reference](core-runtime.md) for APIs, ownership, task limits and error behavior.

## Size, compatibility and verification

The JavaScript async baseline is Safari 27+ / JSPI-capable V8. Real Safari 27 browser execution remains unverified. Component async/jco is experimental upstream. Its scheduler/ownership/cancellation contract comes from the Component toolchain and is not the Core Future contract.

Current scalar async comparison: [taraba / Embassy / wasm-bindgen](async-size.md). Earlier snapshots: [WIT/Core/Component](wit-comparison.md), [parallel JSPI](jspi-concurrent.md). These dated measurements are not the sizes of every generated npm package. npm `build.json` separately records JS, declarations and packaged Wasm bytes, including the optional Component container. A tarball includes declarations and the container; runtime download size depends on which entry is used.

The JSPI Future adapter and stack-snapshot concurrency remain under `experiments/`; neither is silently enabled by library builds. See [adoption gates](jspi-adoption.md).

Verification commands and limits: [development guide](development.md).

Runtime/CLI/JS: MIT. Optional `taraba-allocator`: MPL-2.0, derived from wee_alloc. Preserve its license/source obligations when distributing applications. [THIRD_PARTY.md](../THIRD_PARTY.md).
