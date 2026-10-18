# Documentation

English | [日本語](README.ja.md)

## For library users

| Question | Read |
|---|---|
| Which backend or distribution format should I choose? | [Project overview](../README.md) |
| How do I write WIT, Rust async and a typed npm library? | [Usage guide](guide.md) |
| What do JSPI / Future ownership, cancellation and errors guarantee? | [Core API reference](core-runtime.md) |
| How much does the same async workflow add versus Embassy or wasm-bindgen? | [Current async size comparison](async-size.md) |
| How do I build, test or reproduce measurements? | [Development guide](development.md) |

The usage guide describes supported product commands. `experiments/` is research, not an alternative public API. Component Canonical ABI and the private Core ABI are distinct; npm is a distribution format for either.

## Measurement snapshots and research

Each report is dated and records source hashes. The new async-size report is the current scalar-size comparison. Older snapshots remain useful for their original question and must not be presented as measurements of a later checkout.

| Report | Scope |
|---|---|
| [Async size](async-size.md) / [JSON](async-size.json) | Fresh builds, common synchronous/async algorithm, same allocator, Embassy and wasm-bindgen, all runtime files |
| [WIT comparison](wit-comparison.md) | Earlier Core, standard Component sync/native async, compile/runtime timing |
| [JSPI Future measurements](jspi-future-measurements.md) | Experimental Future adapter and adoption gates |
| [Concurrent JSPI](jspi-concurrent.md) | Unadopted stack snapshots: concurrency, memory and timing |
| [JSPI adoption policy](jspi-adoption.md) | Why the existing Future backend remains available |
| [Engine baseline](engine-baseline.md) | Target engine capabilities and unverified Safari execution |
| [Extraction verification](verification.md) / [provenance](../provenance.json) | Historical extraction evidence |

[JSPI Future source](../experiments/jspi-future/README.md) and [concurrent JSPI source](../experiments/jspi-concurrent/README.md) remain separate from library builds.
