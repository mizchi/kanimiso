# Library usage guide

English | [日本語](guide.ja.md)

Build Rust/Wasm libraries from **WIT contracts**, including async functions, and distribute them as Components or typed npm packages. The toolkit also provides a small JSPI backend and an optional Rust Future runtime for JavaScript hosts. Formerly `kanimiso`.

## Choose an execution contract and a distribution format

| Use case                                                           | Execution option   | Distribution option         | What the user writes / receives                                                                                       |
| ------------------------------------------------------------------ | ------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A Component Model library for an async-capable component host      | `--component`      | no npm flag                 | WIT `async func`, Rust `async fn`; `app.component.wasm` with Canonical ABI                                            |
| An npm library with standard Component async/domain bindings      | `--component`      | `--npm-name @scope/library` | Standard `wit-bindgen` Rust bindings and `jco` JS/TS bindings; records, strings, lists, `result`, typed async results |
| A typed JS/TS library with rich values and Rust async               | `--future`         | npm package by default      | Safe WIT-derived Rust/TS bindings; only used value codecs are emitted |
| A small browser/JS library with numeric boundaries                 | default / `--jspi` | npm package by default      | Synchronous Rust imports suspend through JSPI; WIT-derived typed exports, `Promise<number>`                           |
| Concurrent Rust Future tasks, `spawn_local`, explicit cancellation | `--future`         | npm package by default      | WIT `future<T>` / async func, safe Rust async imports/Guest, typed TS results                                         |

**Choose Component for standard async ABI interoperability.** Core Future supports WIT-typed numeric and rich-value async APIs for JS hosts. Choose Core/JSPI when size is the main constraint and s32/u32/f64 boundaries are sufficient. `taraba new` defaults to a JSPI scaffold. `taraba build` selects Core JSPI/Future from the compiled jsrt/pool imports, rt_poll/rt_drop/rt_settle exports, WIT resources and resource-drop imports, rather than Rust source keywords. `--jspi` / `--future` override detection; Component output requires `--component`.

`--component` uses standard Component Model Canonical ABI. The two Core profiles use a private JS ABI. Component and Core artifacts are different contracts; they are not interchangeable. npm packaging is a separate choice that can be combined with either.

The typed Core async API is available in 0.2.0. Use matching CLI and Rust crate versions; see [installation](#installation). The [capability summary](status.md) separates implemented features, unsupported forms and unverified environments.

## Generated files and editing workflow

| Location                 | Role                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| `wit/app.wit`            | Public API: change types, imports/exports and async contracts here        |
| `src/lib.rs`             | Implement the generated Guest; keep domain logic in ordinary Rust modules |
| `build.rs` (Core Future) | Generate Rust bindings from WIT into OUT_DIR using the installed CLI      |
| `Cargo.toml`             | std/no_std, allocator, dependencies and release settings                  |
| `.cargo/config.toml`     | Scaffold stack 64 KiB / memory limit 1 MiB; adjust for the application    |
| `justfile`               | Optional build/npm shortcuts pinned to the selected execution contract    |
| `pkg/`                   | Generated artifacts; change WIT/Rust and regenerate these files           |

Edit WIT, update Guest/imports using Rust's type errors, run taraba build, and typecheck/test the consumer. std and no_std have the same interface but different panic/allocator code sizes.

Run `taraba build` inside the Cargo project. It compiles the cdylib in release mode for wasm32-unknown-unknown and generates the distribution. Defaults are `Cargo.toml`, the selected package's `wit/`, and `pkg/` output. The Wasm path comes from Cargo JSON artifacts, including custom target directories and library names. Core generates an npm package with `index.js`, `index.d.ts` and `package.json` by default. `--npm-name` overrides the package name. Install jco with `pnpm add -D` and select it with `--jco node_modules/.bin/jco` for Component npm builds.

Output is dedicated to generated files. A one-shot `taraba build` replaces it only after successful generation. A failure exits nonzero and preserves the last successful artifacts.

## Generated npm package

Core `taraba build` assembles a complete npm directory in `pkg/` by default.
No `--npm-name` is required.

| File                            | Purpose                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `index.js`                      | Application-specific `createHost` and typed methods           |
| `index.d.ts`                    | WIT-derived `AppBindings`, `AppExports` and `AppHost`         |
| `app.wasm`                      | Optimized Wasm, exported as `package-name/app.wasm`           |
| `runtime.mjs` / `runtime.d.mts` | Shared runtime and declarations                               |
| `package.json`                  | ESM type, main/module, types, exports and explicit files list |
| `wit/`                          | Public WIT and resolved WIT dependencies                      |
| `helpers-*.mjs`                 | Included only when helpers are used                           |
| `LICENSE.taraba` / `build.json` | taraba license and build/size records                         |

`main` / `module` point to `./index.js`; `types` and the exports types condition
point to `./index.d.ts`. The old `taraba.mjs` entry is not generated as an alias.

| npm field | Cargo project default                      | Override                    |
| --------- | ------------------------------------------ | --------------------------- |
| name      | Selected package name, lowercased          | `--npm-name @scope/library` |
| version   | Package version                            | `--npm-version 1.2.3`       |
| license   | Package license, or UNLICENSED when absent | `--license MIT`             |

Workspace builds use the package selected by `--package`, including inherited
Cargo metadata; `[lib].name` does not set the npm name. Watch rebuilds refresh
metadata as well. For an explicit Wasm input, defaults are the lowercased file
stem, version `0.1.0` and license `UNLICENSED`.

```sh
taraba build
cd pkg
pnpm pack
# When ready to publish to npm:
pnpm publish --access public
```

The directory includes JS, Wasm and declarations; consumers do not need taraba,
Cargo or jco. Local `.taraba/` analysis is excluded from the package. Rebuilding
replaces the generated output, so keep name/version/license changes in Cargo.toml
or CLI options.

Standalone `--component` still generates a standard Component. Add `--npm-name`
and jco for Component npm distribution; it also uses `index.js` / `index.d.ts`,
with jco's native WIT async API.

## Updating generated assets

Runtime assets come from the installed CLI. Upgrade it, then refresh a library
from its source project:

```sh
cargo install taraba-cli --locked --force
taraba update --check
taraba update
```

`--check` compares the recorded CLI version and embedded asset hashes with the
installed CLI. It performs no build or network lookup and exits nonzero when
they differ. It does not check crates.io for a newer CLI or inspect source edits.

`taraba update` replays the last successful build, including package/features,
WIT/world, execution profile, debug/insight, tool paths and npm overrides. Cargo
input recompiles Rust; raw Wasm input regenerates from the original Wasm. Wasm,
JS and TS are generated together in a staging directory, then replace the output
only on success. Watch recipes replay once, without starting a watcher.
Use `--out-dir path` to select a nondefault output. The generated `just update`
shortcut invokes the same command.

Build options live in `pkg/.taraba/rebuild.json`, alongside local analysis,
and are excluded from npm tarballs. They contain local source paths. For an old
output without a recipe, or after moving the project, run `taraba build` once
with the original options. The public `build.json` records the generator version
and sizes; consumers of a published npm library update that library normally.

Rust requirements remain in Cargo.toml/Cargo.lock. If needed, update the used
`taraba` / `taraba-helpers` requirements and lockfile before regenerating. Cargo
builds reject a private runtime from another compatibility line, including renamed
and transitive dependencies. During 0.x, the minor version must match; 0.0.x and
prereleases require the same patch/version. At 1.x and above, the major must match.
The allocator is independent of this JS ABI check. Raw Wasm cannot disclose its
Rust dependency versions, so an update across CLI compatibility lines requires an
explicit source rebuild and `taraba build`. These commands do not bump the
application/npm version or publish.

## Automatic rebuilds

Run `taraba build --watch` in a Cargo project to build immediately and rebuild after changes. It runs Cargo in release mode for wasm32-unknown-unknown, then generates the distribution artifacts. WIT defaults to the selected package's `wit/` directory. Core JSPI/Future is detected on each build; use `--component` for Component output.

```sh
taraba build --watch
taraba build --watch --future
taraba build --watch --component --npm-name @example/orders --license MIT
```

Select a workspace package and Cargo features when needed. The actual Wasm path comes from Cargo's JSON artifact messages, so custom target directories and `[lib].name` work too.

```sh
taraba build --watch --manifest-path crates/orders/Cargo.toml \
  --package orders --no-default-features --features std \
  --wit crates/orders/wit --out-dir web/pkg
```

Watch covers Rust, WIT, Cargo.toml / Cargo.lock, Cargo configuration, resolved local path dependencies and assets. A 150 ms quiet period coalesces edits. Builds run serially; edits during a build trigger a subsequent build. Cargo's target directory, output, `.git`, `node_modules`, `.cache` and staging directories are excluded to avoid rebuild loops.

The output directory is dedicated to generated files. An existing nonempty directory must contain taraba build metadata in `build.json`. Each successful build replaces it after generating artifacts in a separate directory. Rust compilation or WIT validation failures preserve the last successful output and retry after edits. Startup requires a valid Cargo manifest and a selectable cdylib package. Stop with Ctrl-C.

To watch an existing Wasm artifact, add `--watch` to the original input form. This watches the Wasm and WIT; an external build process compiles Rust.

```sh
taraba build target/wasm32-unknown-unknown/release/orders.wasm \
  --wit wit --watch --out-dir pkg
```

`--manifest-path` / `--package` / `--features` / `--no-default-features` apply to Cargo project builds and watch, without a positional Wasm input. Existing options such as `--world`, execution profiles, `--debug` and `--npm-name` carry over to rebuilds.

## Installation

Requires Rust 1.85 or later. Install the CLI from crates.io and add the Rust Wasm target. `taraba new` declares the library crates in the generated Cargo.toml; Cargo fetches those dependencies.

```sh
rustup target add wasm32-unknown-unknown
cargo install taraba-cli --version 0.2.0 --locked
# Install Binaryen 133 and put its tools on PATH.
# --binaryen /path/to/bin or TARABA_BINARYEN can select another location.
```

Component builds also require `wasm-tools 1.245.1`. Component **npm** builds additionally require Node.js 24+ and `@bytecodealliance/jco@1.39.0`; `--jco /path/to/jco` selects the executable. Core builds embed their JS runtime and require neither Node nor jco. No consumer needs this repository checkout or esbuild.

For development of taraba itself, you can install from a checkout instead:

```sh
cargo install --path /path/to/taraba/crates/taraba-cli --locked --force
```

For that development setup, after `taraba new hello --future`, add this override to the application's `Cargo.toml` to use the matching runtime. Registry users of 0.2.0 do not need this override.

```toml
[patch.crates-io]
taraba = { path = "/path/to/taraba/crates/taraba" }
```

If developing the allocator or helpers too, point those dependencies to their corresponding checkout directories. Generated npm packages remain standalone; this setup is for library authors using unreleased code.

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
taraba build --component --out-dir pkg
```

`pkg/app.component.wasm` is optimized, encoded and validated, then checked against the selected WIT world. `app.wit` describes the encoded component and `build.json` records its ABI. `--world` selects a world when WIT contains several. The component path preserves Canonical ABI metadata; it never uses Core externref lowering.

Use WIT records/lists/strings/results for domain contracts. Imported interfaces and resource ownership are generated by the standard tools. Native async needs a component host supporting that proposal; this project's library check validates the artifact and executes its jco output, rather than claiming execution on every native component host. The scaffold supplies no ambient WASI implementation or Preview 1 adapter. Provide the component's declared imports at its host boundary.

## Choose an allocator profile

The generated Cargo.toml uses taraba-allocator with `default-features = false` for
the smallest Wasm. Add features to that dependency according to your workload:

| Workload                                                                 | Features                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------- |
| Minimum code size                                                        | none                                               |
| Frequent small allocations                                               | `size_classes`; measure against the main free list |
| Repeated resizing within one rounded 4-byte word, such as 25→28→25 bytes | `realloc_in_place`                                 |

The features can be combined. `realloc_in_place` is off by default and uses the
usual allocate/copy/free path when the rounded word count changes. Its benchmark
is a targeted resizing case; typical Vec growth has a different workload.
See the [allocator size/performance comparison](allocator.md) for both feature
settings and the common correctness checks. The scalar JSPI example performs no
general allocations, so an allocator change need not change that artifact's size.

## Build an npm library, including TypeScript

From the Component project above:

```sh
pnpm add -D @bytecodealliance/jco@1.39.0
taraba build --component --jco node_modules/.bin/jco \
  --npm-name @example/orders --npm-version 0.1.0 --license MIT --out-dir pkg
cd pkg
pnpm pack
```

This prepares `package.json` with ESM exports, a `types` condition, an explicit `files` list, and all JS/Wasm/type files needed at runtime. jco generates application-specific declarations, including async `Promise<T>` results and domain types. The package also exports the original Component as `@example/orders/component.wasm` and its encoded WIT as `@example/orders/wit`. jco/wasm-tools/taraba are build tools, not runtime dependencies of this package. Build never publishes. Version and license default to the selected Cargo package metadata; a missing license becomes `UNLICENSED`.

A Node consumer installs the tarball (or, after publication, the package) and provides its imports and a core-module loader:

```js
import { readFile } from "node:fs/promises";
import { instantiate } from "@example/orders";

const base = new URL(import.meta.resolve("@example/orders/package.json"));
const api = await instantiate(
  async (name) => WebAssembly.compile(await readFile(new URL(name, base))),
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
import { instantiate, type ImportObject } from "@example/orders";

const imports: ImportObject = {
  "example:orders/domain@0.1.0": {
    evaluate: async (order) => ({ ...order, label: order.label + " ✓" }),
  },
};
const api = await instantiate(load, imports);
const order = await api.process({
  id: 4294967295,
  label: "注文 🍣",
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
taraba build \
  --npm-name @example/tiny --npm-version 0.1.0 --license MIT
```

```js
import { readFile } from "node:fs/promises";
import { createHost } from "@example/tiny";

const host = createHost({ bindings: { add: async (a, b) => (a + b) | 0 } });
const { instance } = await WebAssembly.instantiate(
  await readFile(new URL(import.meta.resolve("@example/tiny/app.wasm"))),
  host.imports,
);
host.attach(instance.exports);
console.log(await host.run(20, 21)); // typed Promise<number>
```

Core JSPI/Future uses `createHost`, native Wasm instantiation, then `attach`. The caller can choose a compiled Module or `instantiateStreaming`. Core generates only `createHost`, without a convenience loader. Component examples continue to use the jco-generated `instantiate`.

The numeric Core API has `AppBindings`, `AppExports`, and `AppHost` generated from WIT; export names/arguments are checked by TypeScript. The default `pkg/index.js`/`index.d.ts` and package.json exports provide this typed API without `--npm-name`. Application methods are generated statically, so editors can complete `host.run(a, b)` without string-based dispatch. `runtime.mjs`/`runtime.d.mts` contain the separate shared runtime. Both formats support debug errors via `--debug`; release uses codes linked to the [error reference](error-codes.md), without shipping a description dictionary.

Core/JSPI serializes each instance across I/O waits; a slow call blocks later calls. Host rejection/trap closes the instance, with no per-call cancellation or Rust Drop guarantee on that path. It does not drive arbitrary Rust Futures or native WIT async. Use `--future` when independent task progress and cancellation are required. Its generated bindings accept world-level and interface WIT `future<T>` / `future` or equivalent `async func`, including numeric, string, list, record and other supported value types, and imported opaque own/borrow resources. Only used codecs are generated. Standard Canonical async ABI requires Component; legacy opaque Promise payloads stay `unknown`. Both Core profiles provide `host.dispose()` with different suspended-task behavior. See the [Core runtime reference](core-runtime.md) and [typed resource/lifecycle examples](typescript.md).

## Helpers for JavaScript builtins

Optional `taraba-helpers` APIs provide RegExp, host strings, Unicode normalization,
segmentation and decoding inside Core JSPI/Future Rust code. Enable the required
features on the crates.io dependency, then run `taraba build` as
usual. No private helper WIT or manual JS bindings need to be added to your
application's public interface.

The build selects individual string, Iterator, Segmenter and Decoder operations
from imports remaining after wasm-opt. Unused helpers add 0 B of JS; using host
strings includes common root infrastructure. See [feature selection](helpers.md#include-only-the-helpers-you-use)
and [string examples and measured sizes](strings.md).

This private Core ABI is separate from the Component Canonical ABI for public
WIT strings, records and lists. Helpers do not support `--component` or JS-free
WASI hosts.

## Size, compatibility and verification

Multiple Core libraries can share their JS runtime when imports resolve to the same ESM URL. Default npm output carries a copy per package, so sharing requires a common chunk. See [ESM cache checks and the build example](esm-cache.md) for measured sizes and instance-isolation checks.

The JavaScript async baseline is Safari 27+ / JSPI-capable V8. Real Safari 27 browser execution remains unverified. Component async/jco is experimental upstream. Its scheduler/ownership/cancellation contract comes from the Component toolchain and is not the Core Future contract.

Current scalar async comparison: [taraba / Embassy / wasm-bindgen](async-size.md). Earlier snapshots: [WIT/Core/Component](wit-comparison.md), [parallel JSPI](jspi-concurrent.md). These dated measurements are not the sizes of every generated npm package. npm `build.json` separately records JS, declarations and packaged Wasm bytes, including the optional Component container. A tarball includes declarations and the container; runtime download size depends on which entry is used.

The JSPI Future adapter and stack-snapshot concurrency remain under `experiments/`; neither is silently enabled by library builds. See [adoption gates](jspi-adoption.md).

Verification commands and limits: [development guide](development.md).

Runtime/CLI/JS: MIT. Optional `taraba-allocator`: MPL-2.0, derived from wee_alloc. Preserve its license/source obligations when distributing applications. [THIRD_PARTY.md](../THIRD_PARTY.md).

Generated npm packages retain MIT/MPL notices and versioned allocator source links.
The application license is separate; update the notice for modified or different
MPL-covered dependencies. See [license provenance](https://github.com/mizchi/taraba/blob/main/THIRD_PARTY.md).
