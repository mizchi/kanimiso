# Async size comparison fixtures

Product usage lives in [the guide](../../docs/guide.md); these are private benchmark crates.

`just compare-async-size` rebuilds synchronous and two-await implementations, executes
the packed artifacts and regenerates English/Japanese [reports](../../docs/async-size.md).
`just check-async-size` performs the same checks without changing docs.

All async backends compile [one Rust algorithm](../wit/shared/compute.rs), all sync
controls compile [one synchronous algorithm](sync.rs). The same 3,507 cases check
every result and host I/O. Async builds also check actual suspension; scheduling
checks distinguish serialization from independent progress. Embassy is not assumed FIFO.

Primary rows use taraba-allocator without size classes. wee_alloc is a separate
control, also without size classes. The official Embassy platform-wasm uses std;
its 1,024 statically typed workers use JsFuture for I/O. A no_std raw executor with
a custom host is a different configuration, not mislabeled as the same backend.
The std critical-section implementation and official WASM event-loop integration
are included. Safe Executor/start and a thread-local Spawner manage initialization.

Metrics include the bundled required JS and every deployed core Wasm, optimized
with the same tools. Component containers and declarations are separate; npm
tarballs are packed, extracted and hash checked. Strict TS uses the extracted
package declarations. Benchmark package manifests are minimal; this is a
controlled post-bundle size measurement, not the unmodified CLI package size.

The private Core Future handle conversion is the existing product bridge. This
fixture introduces no custom raw executor or new lifetime protocol. Native64
Miri/Kani runtime checks do not prove upstream executors, JS or emitted Wasm.
No comparison implies equality of cancellation, Drop, fatal or typed-error contracts.
