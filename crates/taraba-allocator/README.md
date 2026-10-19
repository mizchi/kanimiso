# taraba-allocator

A small allocator for non-shared, single-agent `wasm32-unknown-unknown` applications.
Derived from `wee_alloc_bw` / `wee_alloc`; licensed under **MPL-2.0**.

The crate is being prepared for its first crates.io release. After publication:

```sh
cargo add taraba-allocator@0.1.0 --no-default-features
```

```rust
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
```

`--no-default-features` disables size classes for the smallest code footprint.
The default `size_classes` feature provides a different size/performance tradeoff.
Each of its 32 classes refills an 8 KiB slab. The wasm32 refill size is unchanged;
using a constant removes the previous per-refill quadratic sizing calculation.
`extra_assertions` enables additional internal checks; `instrumentation` is for diagnostics.

Enable `realloc_in_place` when repeated reallocations within the same rounded word
are common. On wasm32, for example, 25→28→25 bytes stays in one 4-byte word group,
so the pointer and payload can be kept. Other sizes use allocate/copy/free.
This feature is off by default; the [comparison](../../docs/allocator.md) records
its code-size cost and targeted throughput separately from the smallest profile.

The unsafe `GlobalAlloc` methods require nonzero sizes, valid `Layout` values and
live pointers with their exact layouts, following Rust's allocator contract.

This allocator is optional for taraba. Fixed task slots are allocated separately.
An application's `Vec`, `Box`, and other general allocations can use this allocator.
It supports non-shared wasm32 memory only. The native page backend is test-only.

See [LICENSE](LICENSE) and [UPSTREAM.json](UPSTREAM.json) for license and provenance.
The implementation type `WeeAlloc` is retained; `Allocator` is its public convenience alias.

Adjacent free cells coalesce during deallocation; allocation traverses an untagged
free list without the former delayed-merge machinery. A right-neighbor merge still
requires an O(n) search. Pointer-provenance and checked-size fixes are retained.
See the [measured size/performance comparison](../../docs/allocator.md) for the pinned
pre-change reference and wee_alloc control. This is not a claim that every workload
is faster or smaller; wee_alloc fails the comparison's adjacent-block reuse oracle.
