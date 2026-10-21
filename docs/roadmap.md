# Expressive Rust libraries with a small runtime

English | [日本語](roadmap.ja.md)

The goal is to ship Rust domain logic as safe, typed async npm libraries with small Wasm/JS artifacts. Keep shared runtime growth minimal and generate feature-specific implementations only when used.

| Order | Work | Acceptance criteria | Status |
|---|---|---|---|
| 1 | Real middleware and measurements | JS URL/JSON, Rust validation/transformation; common algorithms/tests; external npm/TS consumers and size budgets | [Order middleware](order-middleware.md) added |
| 2 | Core resource methods / Rust-defined exported resources | Stateful WIT APIs; test own/borrow, reentrancy, cancellation during borrowing and dispose/Drop; unused cost 0 B | [Implemented in Core Future](resources.md); static methods and guest resources crossing host imports remain unsupported |
| 3 | AsyncIterator / Stream adapters | Define pull, backpressure, cancel/return and Drop; propagate cancellation upstream; unused cost 0 B | Not implemented; JS body readers are distinct from Core stream ABI |
| 4 | Small async composition APIs | join/select/timeout, bounded concurrency and yielding to rendering; verify losing Future Drop, I/O cancellation and starvation | Not implemented |
| 5 | JS builtin helpers | JSON/URL/number formatting with explicit retention, precision, ownership and FFI costs; operation-level generation | Example uses JS adapter; generic Rust helpers not implemented |
| 6 | Consumer application coverage | Vite/Rolldown assets, Workers/shared runtime, Safari-target WebKit and deployed Workers | Safari-target WebKit, module Workers, pack/install, strict TS and Rolldown complete; deployed Workers and further environments remain |

Rich JSPI values are a separate experiment: measure strings/records/lists without a Rust executor while retaining the distinction between JSPI and Future concurrency/cancellation. Core JSPI remains scalar-only today.

Actual copy counts and memory including JS heap remain future work. Order middleware reports requested Rust heap and linear memory, not process-wide memory. Evaluate features against realistic size, throughput and initialization costs as well as expressiveness.
