# Documentation

English | [日本語](README.ja.md)

## For library users

| Question | Read |
|---|---|
| What works today, what is unsupported, and what remains unverified? | [Current capabilities and limits](status.md) |
| WIT → Rust async → TS, interfaces, resources, disposal and pool capacity | [TypeScript interop](typescript.md) |
| Which backend or distribution format should I choose? | [Project overview](../README.md) |
| How do I write WIT, Rust async and a typed npm library? | [Usage guide](guide.md) |
| How do I publish pkg/ and choose the package name/version? | [Generated npm package](guide.md#generated-npm-package) |
| What do JSPI / Future ownership, cancellation and errors guarantee? | [Core API reference](core-runtime.md) |
| How do I resolve a runtime error code? | [Error codes](error-codes.md) |
| Which functions are large, and what keeps formatting code? | [Size warnings and taraba insight](insight.md) |
| How do I report panics without release message formatting? | [Panic hook / handler](panic-reporting.md) |
| Can JS builtins replace large Wasm dependencies? | [taraba-helpers and feature size probes](helpers.md) |
| How do host strings, segmentation, codecs and Rust iterators work? | [Strings and iterators](strings.md) |
| What enters the bundle when I enable helper features? | [Operation selection](strings.md#what-the-build-includes) and [generated/bundled sizes](strings.md#sizes-and-verification) |
| How much does the same async workflow add versus Embassy or wasm-bindgen? | [Current async size comparison](async-size.md) |
| Can multiple libraries share one JS runtime? | [ESM caching and shared chunks](esm-cache.md) |
| How do I build, test or reproduce measurements? | [Development guide](development.md) |

The usage guide describes supported product commands. `experiments/` is research, not an alternative public API. Component Canonical ABI and the private Core ABI are distinct; npm is a distribution format for either.

## Measurement snapshots and research

Each report is dated and records source hashes. The new async-size report is the current scalar-size comparison. Older snapshots remain useful for their original question and must not be presented as measurements of a later checkout.

| Report | Scope |
|---|---|
| What remains in Wasm, and do twiggy/wasm-snip help? | [Section breakdown and snip experiment](wasm-size-analysis.md) (Japanese) |
| [Async size](async-size.md) / [JSON](async-size.json) | Common sync/async algorithm; taraba, Embassy, Tokio, async-executor, async-std, wasm-bindgen and FuturesUnordered; all runtime files |
| [Rich async](rich-async-size.md) / [JSON](rich-async-size.json) | Same record/string/bytes/Result Rust workflow against wit-bindgen; deployed size, local timing and measured memory |
| [Allocator optimization](allocator.md) / [JSON](allocator.json) | Before/after size, V8 kernels, memory reuse/OOM and wee_alloc control (Japanese) |
| [WIT comparison](wit-comparison.md) | Earlier Core, standard Component sync/native async, compile/runtime timing |
| [JSPI Future measurements](jspi-future-measurements.md) | Experimental Future adapter and adoption gates |
| [Concurrent JSPI](jspi-concurrent.md) | Unadopted stack snapshots: concurrency, memory and timing |
| [JSPI adoption policy](jspi-adoption.md) | Why the existing Future backend remains available |
| [Engine baseline](engine-baseline.md) | Target engine capabilities and accepted WebKit validation for Safari |
| [Extraction verification](verification.md) / [provenance](../provenance.json) | Historical extraction evidence |

[JSPI Future source](../experiments/jspi-future/README.md) and [concurrent JSPI source](../experiments/jspi-concurrent/README.md) remain separate from library builds.

[Bundle tuning before/after](bundle-tuning.md): Wasm, JS, gzip and Brotli for the same workload.

- [Order middleware example and measurements](order-middleware.md)
- [Roadmap](roadmap.md)

[Expose stateful Rust resources through WIT](resources.md)

[Stable and latest canary browser E2E](browser-testing.md)
