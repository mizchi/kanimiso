# Bundle size tuning

English | [日本語](bundle-tuning.ja.md)

This compares the same working tree before and after tuning, not two published releases. WIT, Rust algorithm and functionality are unchanged. Both normal and instrumented builds pass the same 216 cases.

Private codec/interface wire names are shortened and identical codec bodies share callbacks. Public WIT/Rust/TS names are retained. Rust trusts the UTF-8 produced by the generated TextEncoder import and skips redundant validation, while retaining zero initialization of the destination Vec. Generated shutdown wrappers share cleanup code; private scope properties in the shared runtime are mangled.

| Rust | Wasm | JS | Total | gzip | Brotli |
|---|---:|---:|---:|---:|---:|
| no_std | 5,318 B → 4,280 B | 4,893 B → 4,449 B | 10,211 B → 8,729 B | 5,166 B → 4,652 B | 4,802 B → 4,335 B |
| std | 9,453 B → 8,415 B | 4,893 B → 4,449 B | 14,346 B → 12,864 B | 7,292 B → 6,790 B | 6,693 B → 6,268 B |

JS is minified with Rolldown and includes the shared runtime once. Gzip level 9 / Brotli quality 11 totals compress files separately, not concatenated Wasm plus JS. Standalone runtime sizes are recorded for each compression mode; all deployed totals in the rich workload decrease.

## Shared JS runtime

| Profile | Raw | gzip | Brotli |
|---|---:|---:|---:|
| release | 3,639 B → 3,585 B | 1,883 B → 1,877 B | 1,716 B → 1,715 B |
| abort | 4,666 B → 4,414 B | 2,224 B → 2,180 B | 2,043 B → 2,003 B |
| jspi | 1,138 B → 1,128 B | 647 B → 646 B | 584 B → 571 B |

Run `just compare-rich-async` for current rich-workload measurements and `just compare-async-size` / `just compare-core-types` for scalar and type tables. [JSON](bundle-tuning.json) records artifact SHA-256 hashes and before/after sizes. Verification covers browser E2E, std/no_std, Unicode including lone surrogates, memory.grow, Drop, cancellation and strict TS.

Both runtime variants now test disposal reentrancy during completed-task Drop. The active task remains marked as running until its destructor finishes, preventing a recursive second Drop.
