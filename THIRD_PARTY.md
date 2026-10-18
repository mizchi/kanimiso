# Third-party code

`crates/taraba-allocator` is a wasm32-only derivative of
[wee_alloc_bw](https://github.com/bourumir-wyngs/wee_alloc_bw), revision
`9a9adc2106df80abd25501194275d7d51a1ba4c4`, itself derived from
[rustwasm/wee_alloc](https://github.com/rustwasm/wee_alloc).
It remains **MPL-2.0**, including its copied helper modules and regression tests.
See `crates/taraba-allocator/LICENSE` and `crates/taraba-allocator/UPSTREAM.json`.
The root MIT license does not replace the license of these files.

The allocator implementation and assertions were changed in the original
wasm-battleground experiments before extraction. Source SHA-256 values at
extraction are recorded in `provenance.json`; `UPSTREAM.json` records the
upstream source hashes. The allocator proof harness in
`verification/kani/harnesses/allocator.rs` is appended to this implementation
only in the generated proof crate under `.cache/kani`.

Rust and Node dependencies are fetched from their registries and retain their
respective licenses; the dependency versions are pinned in lockfiles.
