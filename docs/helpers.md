# Borrow JavaScript builtins to reduce Wasm size

English | [日本語](helpers.ja.md)

`taraba-helpers` (`taraba_helpers` in Rust) provides opt-in JS builtins. Helpers include JS **RegExp**, [host strings, normalization, segmentation, iterators and codecs](strings.md). It works with std or
no_std and the Core JSPI or Future profiles, without depending on a Rust allocator
or async executor. JSON, URL and localized date/number formatting remain candidates, not
implemented APIs.

## Use

Add the crate from crates.io (Rust 1.85+):

```toml
[dependencies]
taraba-helpers = { version = "0.1.0", features = ["regexp"] }
```

```rust
use taraba_helpers::regexp::{InvalidPattern, RegExp};

fn count_matches(texts: &[&str]) -> Result<usize, InvalidPattern> {
    let pattern = RegExp::new("^[a-z]+$")?;
    Ok(texts.iter().filter(|text| pattern.is_match(text)).count())
}
```

Run `taraba build`. Private imports select `helpers-regexp.mjs` automatically;
there are no extra npm dependencies or manual bindings. Application WIT still
describes only the application's public interface. Use native instantiate,
attach exports, and then the generated typed host methods as usual.

Compile once outside matching loops. RegExp can live across a Rust `.await` or
JSPI suspension; cancelling a Future drops it. Rust borrows UTF-8 only during a
synchronous host import. JS decodes immediately, keeps no pointer/view, and reads
the current buffer after memory.grow. The 4-byte handle is local to one instance
and agent (`!Send`, `!Sync`), with no Clone/raw-handle API. `mem::forget` or a fatal
trap may retain JS objects until the host is garbage-collected. JS allocation and
text decoding still have runtime costs.

## Include only the helpers you use

Default Cargo features are empty. Features make Rust APIs available; they do not force all JS implementations into the bundle.

| Feature | APIs | JS selection |
|---|---|---|
| `regexp` | `RegExp::new` / `is_match` | RegExp module; no file or connection code when unused |
| `strings` | `JsString`, normalization, casing, trim, equality, UTF-8 copies | Individual imports remaining after wasm-opt |
| `segmenter` | Grapheme/word/sentence segmentation and Rust Iterator | Segmentation, iteration and item access selected individually |
| `encoding` | Encoding conversion through `TextDecoder` | Decoder and the string operations used |
| `alloc` | `JsString::to_rust_string()` | Explicit copying into Rust `String` only when used |

Enabling all features while using no helpers adds **0 B of JS**. String operations share common root infrastructure, included when host strings are used. Normalization, uppercase, lowercase and trim are selected independently. Segmenter `count()` excludes segment text/index/word-like accessors.

Selection finishes during `taraba build`; CLI users do not need a JavaScript bundler. See the [string and Iterator guide](strings.md) for borrowing, Drop and copying costs. Its [size table](strings.md#sizes-and-verification) records generated JS and Rolldown output separately.

## Regex sizes

All variants pass the same **448 cases**: 8 patterns × 14 texts × 4 repetition
counts in a shared syntax subset. Identical Rust control flow compiles a selected
pattern once, tests it repeatedly, then drops it. These are release opt-level=z /
LTO builds with the same allocator, Core JSPI and Binaryen 133 wasm-opt -Oz.
This measures size, not a performance ranking.

<!-- helpers-regex:begin -->
| Variant | Wasm B | JS B | Total B |
|---|---:|---:|---:|
| regex 1.13.1 default / std | 771150 | 1338 | 772488 |
| regex 1.13.1 std only / std | 234711 | 1338 | 236049 |
| taraba-helpers / std | 818 | 2590 | 3408 |
| taraba-helpers / no_std | 818 | 2590 | 3408 |
<!-- helpers-regex:end -->

JS counts include the shared runtime, generated application bindings and helper.
The RegExp module itself is 611 B. Unused helpers add neither a JS module nor
connection code; the shared runtime stays unchanged. See [ESM sharing](esm-cache.md).
The minimal Rust regex feature set passes this corpus, but does not preserve all
Unicode/property/case-folding capabilities or performance features of defaults.

## Feature probes

These rows probe independent features, rather than comparing equivalent algorithms
between unrelated features. Each std/no_std pair uses the same operation and
tests; no_std uses an unreachable panic handler. Values are optimized Wasm bytes.

<!-- helpers-audit:begin -->
| Probe | Wasm B | code B | data B |
|---|---:|---:|---:|
| baseline-no_std | 51 | 8 | 0 |
| baseline-std | 51 | 8 | 0 |
| format-integer | 6973 | 5746 | 1012 |
| format-integer-no_std | 3947 | 3540 | 241 |
| format-float | 23780 | 19551 | 3970 |
| format-float-no_std | 16517 | 14711 | 1614 |
| hash-map | 8361 | 7384 | 753 |
| btree-map | 6178 | 5217 | 762 |
| btree-map-no_std | 1770 | 1643 | 0 |
| serde-json | 37507 | 26328 | 10856 |
| url | 172053 | 70863 | 100583 |
| chrono-format | 31563 | 21427 | 9855 |
<!-- helpers-audit:end -->

Enabling std alone is not a fixed size tax: the scalar baseline is 51 B in both
modes. Retained panic/formatting code, allocation, generic algorithms and tables
depend on the APIs actually used. In these probes, URL has about 101 KB of data;
default regex has about 351 KB. Function-only attribution misses those tables.

Before compilation, `taraba build` walks normal dependencies of the selected
Cargo package and warns about regex, JSON, URL/IDNA, dates, normalization and
general-purpose executors. Build/dev-only dependencies and unrelated workspace
members are excluded. Presence is a candidate, not evidence of retained bytes.
`--no-size-warnings` suppresses dependency and formatting hints.

```sh
taraba build --insight
taraba insight --retained --top 20
taraba insight --paths regex
taraba insight --paths fmt
```

The optimized report also groups regex, JSON, URL/Unicode, dates, collections and
executors by symbol names. This is not exact crate ownership: inlining and shared
code cross group boundaries, and data is accounted separately from functions.
Table code/data sizes include section headers; total Wasm also includes types,
imports, exports and other sections.

## Next candidates

| Operation | JS builtin | Contract to settle first | Status |
|---|---|---|---|
| Regex | RegExp | JS syntax, Unicode, flags, search complexity | Implemented: compile/is_match/Drop |
| JSON | JSON.parse/stringify | Integer precision, schemas, JS roots versus Rust copies | Not implemented |
| URL/IDNA | URL/URLSearchParams | WHATWG semantics, base URL, normalization/version differences | Not implemented |
| Dates | Date/Intl | Millisecond precision, timezones, locale and calendars | Not implemented |
| Normalization | String.normalize | Form, engine Unicode version, output ownership | [JsString::normalize](strings.md) |
| Number formatting | String(number)/toFixed | f64 and i64/u64 precision, Rust formatting differences | Not implemented |
| Collections | Map/Set | Rust Hash/Eq versus JS identity, value ownership | Not implemented |
| Async/timers | Promise/event loop | JSPI serial entry versus Future concurrency/cancellation | Existing taraba API |

`alloc` is sufficient for many Rust strings/collections. std fs/net/thread APIs do
not directly provide browser I/O on wasm32-unknown-unknown; declare host I/O in WIT.
Moving fine-grained loops to JS may increase FFI and conversion costs.

## Semantics and verification

RegExp uses JS Unicode `u`, without `g`/`y`, so repeated tests are independent of
lastIndex. Syntax errors return the zero-sized InvalidPattern. Captures,
replacement, arbitrary flags and offsets are not implemented. This is not a
drop-in replacement for Rust regex: syntax, anchors and Unicode classes differ,
and JS RegExp does not inherit Rust regex's worst-case O(m*n) search guarantee.
No API hides UTF-16 versus UTF-8 offset differences.
[Rust regex contract](https://docs.rs/regex/1.13.1/regex/),
[JS Unicode](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/unicode),
[lastIndex](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/lastIndex).
See also [V8's explanation of backtracking and linear-time engines](https://v8.dev/blog/non-backtracking-regexp).
An engine-specific optimization is not a complexity guarantee of this library.

The private ABI is validated from [versioned WIT](../crates/taraba-helpers/wit/regexp.wit).
It is an explicit UTF-8 ptr/len **Core memory ABI**, not Component Model canonical
string/resource lowering. Component and native WASI hosts are outside this helper.

`just helpers-check` runs probes, the regex corpus, std/no_std × JSPI/Future common
3507-case and scheduling checks, cancellation/drop, and npm pack/install with
strict TS. `just compare-helpers` updates the tables and
[snapshot](helpers-size.json), including fixture Cargo.lock contents and input hashes.
Miri checks borrowed buffers and Drop with a model host. Kani checks the unchanged
RegExp API against a modeled FFI for any u32 handle and boolean result, including
zero/error and exactly-once release, on native64. These are not proofs of the JS
regex engine, Map or Wasm pointer transport. Execution is checked in V8/Node;
Safari's actual browser has not been tested.
