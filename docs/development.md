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
| `just check` | Rust/JS tests, formatting, Core fatal/ownership behavior, JSPI spills, npm consumer checks and active documentation links |
| `just library-check` | Current CLI: pack/install outside the repo, strict TS, three profiles × std/no_std, rich Component domain/errors, shared Core ESM and instance isolation |
| `just package-check` | Packages all three crates, installs an unpacked CLI, repeats external consumers and npm library generation |
| `just compare-async-size` | Common sync/async implementations with Embassy, Tokio, async-executor, async-std, wasm-bindgen and FuturesUnordered; writes docs/async-size.{json,md} and Japanese report |
| `just check-async-size` | Same comparison and correctness checks; writes only .cache/async-size |
| `just compare-allocator` / `just check-allocator` | Common allocator oracle and nine V8 kernels for the fixed reference, current default/optional realloc feature and wee_alloc; check writes .cache only |
| `just workers --jspi-concurrent` | Existing fixtures on local workerd, including unadopted concurrent experiment |
| `just modern` | Optional js-string, GC, exnref and funcref capability probes |
| `just stress 60` | Runtime churn/ownership stress |
| `just miri` / `just kani` | Selected native64 runtime/allocator components and models |

Before registry publication, package-check patches dependencies to unpacked .crate archives. That proves archive contents and external consumer builds, not a successful crates.io install. No task publishes to npm or crates.io. The usage guide's registry commands describe the intended post-publication workflow.

When changing unsafe ownership/lifetimes, run check, miri, kani and stress. Native component proofs do not cover JS, V8/WebKit, generated Wasm, the full intrusive WAT pool, or the benchmark's upstream executors. Browser JSPI and Component Canonical ABI behavior require runtime tests as well.

The active realloc Kani harness verifies the native64 word-class/capacity predicate
for every valid positive size. Pointer/payload/free-list proofs in `just kani-explore`
and `just kani-realloc-explore`
have exceeded the 60-second limit and are unproved. Miri and the Wasm oracle test
payloads, updated-layout deallocation, class changes and failed-realloc preservation.

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

CI runs the product, comparison, package, modern-feature, stress and workerd checks. Its verification artifact includes library-check.json, async-size/check.json, package-check.json and the older fixture reports. Compare input hashes when relating a downloaded artifact to a checkout.

[Documentation index](README.md) · [source/license provenance](../THIRD_PARTY.md).
