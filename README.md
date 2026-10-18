# kanimiso

**English** | [日本語](README.ja.md)

A small Rust/Wasm runtime that uses JavaScript Promises to run local futures.
Supports both `std` and `no_std`, without requiring `wasm-bindgen` or Tokio.

The Rust crate is `kanimiso`; the JS package is `@mizchi/kanimiso`.
This is an experimental project used from a Git checkout. It has not been published to npm or crates.io.

```sh
just setup
just check
```

Requirements: Node.js 24+, pnpm 12.11.2, just, and Rust 1.98.0.
`just setup` installs the Wasm target and Binaryen 133, verifying its SHA-256 checksum.
The build is independent of the original wasm-battleground checkout, artifacts, and result files.

## Usage

```js
import { readFile } from "node:fs/promises";
import { instantiate } from "./dist/index.mjs";

const runtime = await instantiate(
  await readFile("dist/examples/no_std-minimal.wasm"),
  { deferredAdd: (a, b) => Promise.resolve((a + b) | 0) },
);
console.log(await runtime.promise("start", 7, 9)); // 17 (two awaits)
```

`deferredAdd` is an example I/O hook retained for compatibility with the original tests.
Define application imports with `bindings: { fetchData: (...) => ... }` and import them
from the Wasm `app` module. Call Wasm through the returned runtime's `call` or `promise` methods.
Calling raw `instance.exports` directly bypasses the fatal-error guards.
See [src/index.d.ts](src/index.d.ts) for JS types and [src/error-codes.json](src/error-codes.json) for error codes.
`./dist/index-debug.mjs` adds descriptive messages to the same error codes.

```rust
use kanimiso::{future_to_promise, JsPromise, spawn_local};

fn launch(promise: JsPromise) -> JsPromise {
    future_to_promise(async move {
        let value = promise.await?;
        Ok(value)
    })
}

fn detached() {
    let _handle = spawn_local(async { /* Rust future */ });
}
```

Build the Rust application as a `cdylib` for `wasm32-unknown-unknown` and provide
`rt_poll`, `rt_drop`, and `rt_settle`. See [examples/promise](examples/promise) for a complete implementation.
A `no_std` application chooses its own panic handler and allocator.
The included `wee-port` is an optional general-purpose allocator; tasks use a fixed storage region.

## Building an application

Provide an ABI manifest that declares reference ownership at the application boundary.
Application functions can use arbitrary names.

```json
{
  "imports": {
    "app.fetchData": { "params": ["i32"], "result": "own" }
  },
  "exports": {
    "run": { "params": ["i32"], "result": "own" }
  }
}
```

```sh
node tools/build-wasm.mjs target/wasm32-unknown-unknown/release/app.wasm \
  --abi abi.json --output dist/app.wasm
```

`i32` and `f64` are scalars. `own` transfers an owned JsValue/JsPromise root;
`borrow` borrows a reference and is supported only for import parameters.
An `own` value is a `u32` in the raw Rust ABI and an `externref` after conversion.
The build fails if a declared signature does not match the Wasm signature.
`rt_*` and `jsrt` are reserved; application imports use the separate `app` namespace.
The tool does not infer `own` or `borrow` boundaries for undeclared functions.

The build pipeline converts the externref ABI, links the intrusive pool, removes helper exports,
then runs `wasm-opt -Oz --flatten --rereloop -Oz --converge` and renames private imports.
Use Wasm and JS built together; do not mix minifier import maps across versions.
The binder handles explicit scalar (`i32` / `f64`) and reference boundaries; it is not a general Rust binding generator.

## Runtime contract

- `spawn_local` defers its first poll to a microtask and coalesces duplicate wakes.
- Dropping a JoinHandle detaches the task. Explicit cancellation drops its Future and subscriptions.
- A successful result is committed to its Promise only after Rust Drop completes.
- A fatal import exception or Wasm trap preserves the first exception, rejects all tasks, and releases JS roots.
  After a fatal error, the host does not retry Rust Drop or reuse the instance.
- External rejection values retain object identity and are not wrapped in another Error.
- Token IDs are never reused, preventing late Promise settlements or stale Wakers from reaching another task.
- The runtime requires non-shared memory and a single JS agent. Do not share it between JS workers.

Task storage is **128 KiB / 128 B × 1024 slots / alignment ≤ 64**.
Exceeding either a slot's capacity, including the Future and its header, or the concurrent task limit causes a fatal OOM.
This is a bounded executor. The examples use 256 KiB of initial linear memory with a 1 MiB maximum.
The minimal `no_std` example does not link general-purpose allocator code.

The targets are V8 and Safari. The runtime uses `Promise.withResolvers`, `externref`, and `queueMicrotask`.
Run `just modern` to probe newer Wasm features. Testing in the Safari browser is still pending;
checks in the macOS system JavaScriptCore shell are recorded separately.

## Verification

```sh
just check       # Node unit tests, native Rust, real std/no_std Wasm, regressions, OOM, fuzz
just stress 60   # At least 60 seconds; compare std/no_std with identical seeds
just miri       # Waker, types, storage layout, general-purpose allocator
just kani-setup # Optional: Kani 0.67.0
just kani       # Bounded proofs of Waker/allocator components and an ID model
just workers    # Local workerd; no deployment to Cloudflare production
just modern     # Feature probes for js-string, exnref, typed funcref, and GC
```

Kani verifies selected components and models on native 64-bit targets. It does not prove
the JS engine, intrusive WAT, Wasm code generation, or the entire runtime.
Errors, Drop, reentrancy, stale Wakers, and OOM are also tested with real Wasm instances.
Results are saved to `.cache/check.json`, `stress.json`, `workers.json`, and `modern.json`.
See [docs/verification.md](docs/verification.md) for verification results at extraction time.

## Layout and provenance

- `crates/kanimiso`: Rust API, Promise Future, Waker, and fixed backing storage.
- `src`: JS host, error codes, intrusive WAT allocator, and JS/TypeScript API.
- `tools/bridge`: Manifest-driven externref ABI converter.
- `examples/promise`: The same algorithm in std/no_std builds, with separately built probes.
- `tests`: Unit tests and real-Wasm regression, failure, and differential fuzz tests.
- `verification/kani`: Component proof harnesses and the ID model.
- `crates/wee-port`: General-purpose wasm32 allocator, licensed under MPL-2.0.

Extracted from the working tree of wasm-battleground. The original comparison experiments and
measurement history remain in that repository. `provenance.json` records SHA-256 hashes of the source files.
Changes made during extraction include removing external path dependencies, naming the public packages,
adding ABI manifests and guarded application bindings, and adding the package loader and verification tasks.
Original measurements are not reused as the sizes of the extracted runtime.

The runtime is MIT-licensed; `crates/wee-port` remains MPL-2.0. See [THIRD_PARTY.md](THIRD_PARTY.md).
