# Development and verification

English | [日本語](development.ja.md)

For application usage, start with the [usage guide](guide.md). Repository contributors need Node.js 24+, pnpm, Rust and just.

```sh
git clone https://github.com/mizchi/taraba.git
cd taraba
just setup
just check
```

setup installs dependencies, the Wasm Rust target, Binaryen 133 and wasm-tools 1.245.1. The async comparison separately installs a checksum-pinned wasm-bindgen CLI 0.2.129. All comparison crates have committed Cargo.lock files.

| Task | Verifies / produces |
|---|---|
| `just browser-check` | Chrome and Playwright WebKit E2E: rich values, memory growth, JSPI, fetch cancellation, resources and disposal; accepted Safari validation substitute |
| `just webkit-latest-check [version]` | [Latest WebKit E2E](browser-testing.md); isolated @next or a specified version, engine metadata, HTML and traces |
| `just interfaces-check` / `just resources-check` | Namespaced bindings, imported methods and Rust-defined resources, own/borrow/Drop and reentrant shutdown; npm pack/install, strict TS and type/instance identity |
| `just pool-check` | Compiled task-pool capacity, raw-Wasm metadata agreement, exhaustion, memory and watch/update preservation |
| `just check-rich-async` | Same 216 rich-async workload cases and deployed-size ceilings; writes only .cache |
| `just core-types-check` / `just compare-core-types` | Core value-codec round trips, ownership, strict TS, unused types +0 B; per-type size snapshots |
| `just task-features-check` | Oversized/over-aligned Futures, zero-cost small frames, AbortSignal isolation, real fetch abort, watch/update and strict TS |
| `just compare-rich-async` | Shared record/string/bytes/Result algorithm against wit-bindgen; deployed size, local timing and separately instrumented memory |
| `just msrv-check` | Rust 1.85.0: native CLI and all-feature Wasm libraries; install the toolchain and Wasm target first |
| `just panic-check` | Core std/no_std × JSPI/Future panic reports, release/debug, ordinary formatting/traps and payload formatting before the hook; also part of check |
| `just insight-check` | Formatting hints, optimized size/retention inspection, common cases against ordinary builds, npm analysis exclusion and stale-view rejection |
| `just check` | Rust/JS tests, formatting, Core fatal/ownership behavior, JSPI spills, npm consumer checks and active documentation links |
| `just library-check` | Current CLI: pack/install, strict TS, three profiles × std/no_std, raw/Cargo/watch update replay and rollback, rich Component domain/errors, shared Core ESM and instance isolation |
| `node tools/check-runtime-abi.mjs` | Published 0.1.0 runtime as a negative control: independent SemVer/ABI guards reject incompatible Cargo/raw inputs, previous output preserved; also included in library/package checks |
| `just package-check` | Packages all four crates, installs an unpacked CLI, repeats external consumers and npm library generation |
| `just watch-check` | Real Cargo/CLI watch: workspace/features/local dependencies, recovery, output exclusions, edits during builds and Ctrl-C |
| `just compare-async-size` | Common sync/async implementations with Embassy, Tokio, async-executor, async-std, wasm-bindgen and FuturesUnordered; writes docs/async-size.{json,md} and Japanese report |
| `just analyze-wasm-size` | Rebuild the common fixtures, profile with twiggy, and test custom stripping / memory packing / wasm-snip with negative controls |
| `just check-async-size` | Same comparison and correctness checks; writes only .cache/async-size |
| `just compare-allocator` / `just check-allocator` | Common allocator oracle and nine V8 kernels for the fixed reference, current default/optional realloc feature and wee_alloc; check writes .cache only |
| `just workers --jspi-concurrent` | Existing fixtures on local workerd, including unadopted concurrent experiment |
| `just modern` | Optional js-string, GC, exnref and funcref capability probes |
| `just stress 60` | Runtime churn/ownership stress |
| `just miri` / `just kani` | Selected native64 runtime/allocator components and models |

Before registry publication, package-check patches dependencies to unpacked .crate archives. That proves archive contents and external consumer builds, not a successful crates.io install. No task publishes to npm or crates.io. The usage guide's registry commands describe the intended post-publication workflow.

For local library development, replace a registry dependency with a checkout
path, for example `taraba-helpers = { path = "../taraba/crates/taraba-helpers", features = ["strings"] }`.
All four published crates declare Rust 1.85 as their minimum; CI checks exact
1.85.0 separately from the repository's pinned development toolchain.

See the [release procedure](releasing.md) for publish order, clean-commit checks,
registry consumer verification, and npm source/license notices.

When changing unsafe ownership/lifetimes, run check, miri, kani and stress. Native component proofs do not cover JS, V8/WebKit, generated Wasm, the full intrusive WAT pool, or the benchmark's upstream executors. Browser JSPI and Component Canonical ABI behavior require runtime tests as well.

The active realloc Kani harness verifies the native64 word-class/capacity predicate
for every valid positive size. Pointer/payload/free-list proofs in `just kani-explore`
and `just kani-realloc-explore`
have exceeded the 60-second limit and are unproved. Miri and the Wasm oracle test
payloads, updated-layout deallocation, class changes and failed-realloc preservation.

The Promise Kani harness executes the production `JsFuture`/`JsValue` code with a recording host model: initial/pending/settled/consumed Drop, success/rejection/undefined and every nonzero u32 subscription ID. Miri also exercises external Waker replacement and exhaustion. The proof does not cover JS or the wasm32 pointer bridge.


`just helpers-check` verifies RegExp and size probes, std/no_std × JSPI/Future, cancellation/drop, and npm/TS. `just compare-helpers` updates the [results](helpers.md). Default Miri and Kani tasks also include the RegExp API with model hosts.

## Measurements

The [current scalar async size comparison](async-size.md) is reproducible with compare-async-size. It counts all deployed Wasm/JS, separates declarations/container/tarball, records source/artifact hashes and runs the same oracle before reporting a number. It does not measure performance. The sync baseline includes the selected backend's public glue, so its async increment is distinct from the full runtime total.

The comparison's own fixtures do not require a wasm-battleground checkout. The official Embassy WASM platform requires std; do not label it no_std. The raw Embassy/custom-host historical experiment is a different configuration. Competing allocators are controlled separately.

Older timing experiments remain available:

```sh
just compare-wit
just experiment-jspi-future
just experiment-jspi-concurrent
```

These commands regenerate dated snapshots. Their check variants validate fixtures without rewriting the historical measurement docs. Concurrent JSPI and the Future adapter stay experimental; [adoption gates](jspi-adoption.md) apply. Do not silently promote them into public builds.

The CI workflow is configured for product, comparison, package, modern-feature, stress and workerd checks. Its verification artifact includes library-check.json, async-size/check.json, package-check.json and the older fixture reports. Compare input hashes when relating a downloaded artifact to a checkout; a successful local run alone is not evidence that the same commit passed GitHub Actions.

[Documentation index](README.md) · [source/license provenance](../THIRD_PARTY.md).

`just strings-check` verifies normalization, segmentation, decoding and typed iterators. `just compare-strings` updates the [size table](strings.md). Miri/Kani include shared Root/Iterator ownership.

`just browser-check` runs rich values, memory.grow, JSPI, real fetch cancellation, resource ownership and disposal. Local Chrome 156 and Playwright WebKit 27.2 checks passed. WebKit E2E completes Safari-target validation; an additional Safari.app run is not required. Independent browser and rich-async jobs are configured in CI for these engines and the same 216 workload cases with deployed-size ceilings. Timing is reported without a CI threshold. See the [verification boundary](status.md#verification-boundary).

[Latest WebKit commands, coverage and results](browser-testing.md).
