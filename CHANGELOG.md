# Changelog

## 0.2.1 — 2026-10-22

- Add typed Core imported resource instance methods, preserving the JS receiver.
- Expose Rust-owned resources through WIT constructors and synchronous/async
  methods with generated Rust and TypeScript APIs. Track own/borrow lifetimes,
  cancellation, disposal and reentrant Drop using generation-checked Rc storage.
  Static methods, returned/nested borrows, multiple export aliases and guest
  resources crossing host imports remain unsupported in Core.
- Keep shared runtime assets unchanged. Unused imported methods and exported
  resource type declarations add 0 B to deployed Wasm and minified JS.
- Add an order middleware example, common correctness tests and size measurements
  against standard wit-bindgen Component output.
- Expand browser E2E to concurrent borrows, independent cancellation, late
  completion, traps, reentry, synchronous resources and module Workers. Test
  stable Chrome/WebKit and isolated current Playwright canary WebKit in CI.
- Accept Playwright WebKit E2E as the Safari validation substitute; record the
  actual engine and the validation method in reports.

Update both CLI and Rust runtime to 0.2.1 for the new resource bindings. Existing
0.2.0 APIs and private runtime ABI revision 1 remain compatible. Private helper
WIT versions remain 0.1.0. Allocator/helper crates are versioned together with
the CLI/runtime; this release adds no allocator or helper ABI changes.

## 0.2.0

- Generate safe Rust async imports/Guest implementations and TypeScript bindings
  from Core WIT world/interface functions, including rich value types.
- Support imported opaque resource ownership, async borrows and typed resource
  constructor factories. Resource methods and guest-defined resources continue
  to use the standard Component path.
- Add explicit host disposal, opt-in per-call AbortSignal cancellation, automatic
  allocation for oversized Futures and configurable task pool capacity.
- Validate CLI/Rust crate compatibility and raw runtime ABI metadata before
  replacing generated output. ABI metadata is removed from deployed Wasm.
- Generate standalone npm packages with typed hosts, optional JS string helpers,
  watch/update support and size diagnostics.

Upgrade the CLI and Rust crate dependencies together to 0.2.0 and rebuild the
Wasm/JS/types package. Existing 0.1.x Rust runtime dependencies are rejected by
CLI 0.2.0; old raw Wasm without runtime ABI metadata requires a source rebuild.
Private helper WIT interface versions remain 0.1.0 because their ABI is unchanged.

Core JSPI remains serialized per instance. Standard Component async bindings use
wit-bindgen/jco. Chrome and Playwright WebKit are covered by CI; Safari.app and
native Component-host execution remain unverified.
