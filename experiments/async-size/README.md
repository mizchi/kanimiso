# Async size comparison fixtures

Product usage lives in [the guide](../../docs/guide.md); these are private benchmark crates.

`just compare-async-size` rebuilds synchronous and two-await implementations, executes
the packed artifacts and regenerates English/Japanese [reports](../../docs/async-size.md).
`just check-async-size` performs the same checks without changing docs.

All async backends compile [one Rust algorithm](../wit/shared/compute.rs), all sync
controls compile [one synchronous algorithm](sync.rs). The same 3,507 cases check
every result and host I/O. Async builds also check actual suspension; scheduling
checks distinguish serialization from independent progress; added schedulers and
Embassy are not assumed FIFO. The build/report support matrix lives in
[backends.mjs](backends.mjs), including explicit std-only configurations.

Primary rows use taraba-allocator without size classes. wee_alloc is a separate
control, also without size classes. The official Embassy platform-wasm uses std;
its 1,024 statically typed workers use JsFuture for I/O. A no_std raw executor with
a custom host is a different configuration, not mislabeled as the same backend.
The std critical-section implementation and official WASM event-loop integration
are included. Safe Executor/start and a thread-local Spawner manage initialization.

Additional configurations use Tokio 1.53.3 (rt only, a shared current-thread Runtime
and LocalSet), async-executor 1.14.0 (shared LocalExecutor), and async-std 1.13.2
(default features plus unstable spawn_local). Tokio's safe JS driver polls the
LocalSet inside a block_on whose root immediately returns its Poll result; it
never blocks the JS thread waiting for I/O. Tokio and async-executor each retain
one driver per instance. Their child tasks are joined through the same Promise
boundary; these bridge bytes are counted. No Tokio timer/net/threadpool or smol
I/O reactor is implied. async-std is discontinued and retained for comparison.

FuturesUnordered is a separate task-collection reference, with alloc-only no_std
and std builds. Each invocation pushes one compute Future and awaits next();
this is not an independent spawn runtime. Full reports state these contracts
and show growth above the shared wasm-bindgen-futures bridge.

Every Promise-based wasm-bindgen profile also checks rejected I/O at both await
points, rejection-object identity, an independent successful task and subsequent
reuse. This recovery contract is not imposed on JSPI/Core Future/Component.

Metrics include the bundled required JS and every deployed core Wasm, optimized
with the same tools. Component containers and declarations are separate; npm
tarballs are packed, extracted and hash checked. Strict TS uses the extracted
package declarations. Benchmark package manifests are minimal; this is a
controlled post-bundle size measurement, not the unmodified CLI package size.

The private Core Future handle conversion is the existing product bridge. This
fixture introduces no custom raw executor or new lifetime protocol. Native64
Miri/Kani runtime checks do not prove upstream executors, JS or emitted Wasm.
No comparison implies equality of cancellation, Drop, fatal or typed-error contracts.
