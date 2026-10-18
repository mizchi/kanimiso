# kanimiso-allocator

A small allocator for non-shared, single-agent `wasm32-unknown-unknown` applications.
Derived from `wee_alloc_bw` / `wee_alloc`; licensed under **MPL-2.0**.

The crate is being prepared for its first crates.io release. After publication:

```sh
cargo add kanimiso-allocator@0.1.0 --no-default-features
```

```rust
#[global_allocator]
static ALLOCATOR: kanimiso_allocator::Allocator = kanimiso_allocator::Allocator::INIT;
```

`--no-default-features` disables size classes for the smallest code footprint.
The default `size_classes` feature provides a different size/performance tradeoff.
`extra_assertions` enables additional internal checks; `instrumentation` is for diagnostics.

This allocator is optional for kanimiso. Fixed task slots are allocated separately.
An application's `Vec`, `Box`, and other general allocations can use this allocator.
It supports non-shared wasm32 memory only. The native page backend is test-only.

See [LICENSE](LICENSE) and [UPSTREAM.json](UPSTREAM.json) for license and provenance.
The implementation type `WeeAlloc` is retained; `Allocator` is its public convenience alias.
