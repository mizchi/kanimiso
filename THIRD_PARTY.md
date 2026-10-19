# Third-party code

`crates/taraba-allocator` is a wasm32-only derivative of
[wee_alloc_bw](https://github.com/bourumir-wyngs/wee_alloc_bw), revision
`9a9adc2106df80abd25501194275d7d51a1ba4c4`, itself derived from
[rustwasm/wee_alloc](https://github.com/rustwasm/wee_alloc).
It remains **MPL-2.0**, including its copied helper modules and regression tests.
See `crates/taraba-allocator/LICENSE` and `crates/taraba-allocator/UPSTREAM.json`.
The root MIT license does not replace the license of these files.

The allocator depends on `memory_units` 0.4.0 by Nick Fitzgerald and Sergey
Pepyakin, also MPL-2.0. Its source and license are available from the
[Cargo source archive](https://crates.io/api/v1/crates/memory_units/0.4.0/download).

Generated npm packages include `LICENSE.taraba` (MIT),
`LICENSE.taraba-allocator` (MPL-2.0), `UPSTREAM.taraba-allocator.json` and
`NOTICE.taraba`. The notice links to versioned source archives of the default
allocator and memory_units, and is included even if the allocator is unused.
The application's package.json license remains independent. These notices are
not a dependency-license scanner: distributors using a different version or
modified covered source must provide its corresponding source and update the
notice before distribution. Keep applicable notices/source access information
available when serving Wasm independently from the npm package.
See [MPL section 3](https://www.mozilla.org/en-US/MPL/2.0/) and
[Mozilla's distribution FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

The allocator implementation and assertions were changed in the original
wasm-battleground experiments before extraction. Source SHA-256 values at
extraction are recorded in `provenance.json`; `UPSTREAM.json` records the
upstream source hashes. The allocator proof harness in
`verification/kani/harnesses/allocator.rs` is appended to this implementation
only in the generated proof crate under `.cache/kani`.

Rust and Node dependencies are fetched from their registries and retain their
respective licenses; the dependency versions are pinned in lockfiles.

The native CLI's size inspector uses `twiggy-ir` 0.8.0 (MIT/Apache-2.0) for
demangling and dominators, with `wasmparser` 0.252.0 for modern Wasm decoding.
These are CLI dependencies; they are not linked into guest Wasm or JS runtimes.
