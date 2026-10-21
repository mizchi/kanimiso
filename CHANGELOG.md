# Changelog

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
