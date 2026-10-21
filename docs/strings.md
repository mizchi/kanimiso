# Keep strings in JS and consume JS iterators from Rust

English | [日本語](strings.ja.md)

`taraba_helpers::string::JsString` owns a JS string through a 4-byte private root.
It supports normalization, uppercase/lowercase, trim, equality, explicit UTF-8
copies, code-point iteration, Intl.Segmenter and TextDecoder. Works with std or
no_std and Core JSPI or Future, without a Rust allocator/executor dependency.
JS allocations and string conversion costs still exist.

## Features and use

```toml
[dependencies]
taraba-helpers = { version = "0.2.1", features = ["segmenter"] }
```

| Feature | API |
|---|---|
| strings | JsString, normalization, casing, trim, equality, explicit UTF-8 copies |
| iterator | JsIterator<T>; with strings, code_points() |
| segmenter | Segmenter; enables strings and iterator |
| encoding | Reusable Decoder; enables strings |
| regexp + strings | RegExp::new_js/is_match_js without a Rust string round trip |
| alloc | JsString::to_rust_string() |

`values` is the shared internal root infrastructure. Defaults enable no helpers.

## What the build includes

`taraba build` selects individual string, Iterator, Segmenter and Decoder
operations from imports remaining after wasm-opt. Cargo features make APIs
available; they do not force their implementations into the bundle. Enabling
all features while using no helpers adds **0 B of helper JS**.

For example, `JsString::from(text).utf16_len()` retains UTF-8 input, UTF-16
length and the shared root infrastructure. It excludes normalization, casing,
trim, TextEncoder, Iterator, Segmenter and the Decoder module. Uppercase,
lowercase and trim are selected independently. Counting segments excludes
segment text/index/word-like accessors. Selection happens during generation,
without requiring a JavaScript bundler on the CLI user's machine. The shipped
WIT remains the ABI contract.

```rust
use taraba_helpers::string::JsString;

fn utf16_units(input: &str) -> u32 {
    JsString::from(input).utf16_len()
}
```

This example needs only `strings`. UTF-8 input uses `TextDecoder`, but does not
include the separate `encoding::Decoder` API for a requested encoding. Rust
handles the length and ownership; there is no copy into Rust `String`.

Multiple operations reuse the root infrastructure. Adding measurements of
isolated features would count that common cost more than once. These are code
size savings; JS allocation, string conversion and FFI still have runtime costs.

Application WIT and typed host methods are unchanged. This does not add canonical WIT string exports to the Core profile.
See [Core versus Component](guide.md).

```rust
use taraba_helpers::string::{JsString, Normalization};
let text = JsString::from("  Ａe\u{301}🦀  ")
    .normalize(Normalization::Nfkc)
    .trim()
    .to_uppercase();
let mut output = [0u8; 64];
let written = text.write_utf8(&mut output);
```

`From<&str>` decodes during the synchronous import, retaining no pointer/view.
Subsequent operations use host strings. Clone owns a new root to the same
immutable value; Drop releases that root. `write_utf8` writes the largest complete
UTF-8 prefix that fits, returns bytes written and leaves the rest unchanged.
It does not borrow JS UTF-16 storage as a Rust &str. `utf8_len` currently creates
a temporary encoded JS buffer. `to_rust_string` requires alloc and performs a
Rust allocation/copy; use it only when a Rust String is needed.

## Iterator composition

```rust
use taraba_helpers::{
    segmenter::{Granularity, InvalidLocale, Segmenter},
    string::{JsString, Normalization},
};
fn first_words(input: &str)
    -> Result<impl Iterator<Item = JsString>, InvalidLocale>
{
    let text = JsString::from(input).normalize(Normalization::Nfc);
    let segmenter = Segmenter::new("ja", Granularity::Word)?;
    Ok(segmenter.segment(&text)
        .filter(|part| part.is_word_like() == Some(true))
        .take(3)
        .map(|part| part.text()))
}
```

The iterator can outlive both Rust input/segmenter handles: its JS cursor owns
the required source state. Each yielded item also has independent ownership.
The typed producers are code_points() yielding JsString and segment() yielding
Segment. Public APIs cannot construct arbitrary typed cursors from raw IDs.

| Action | Contract |
|---|---|
| next | One JS next(), with a new root only for a yielded item |
| Exhaustion | Release cursor without return(); later next always returns None |
| Early Drop | Retire cursor before calling optional return(); ignore its result |
| map/filter/take/collect | Standard Rust Iterator adapters |
| Across await | Own cursor/items across suspension; Future cancellation drops them |

JsIterator implements Iterator and FusedIterator, adapting synchronous JS -> Rust.
Even count currently crosses FFI for each item; this does not imply it beats bulk
JS processing. collect::<Vec<_>>() needs the application's allocator; JsIterator
itself does not allocate in Rust.

## Units, codecs and errors

code_points() is not grapheme segmentation: use Granularity::Grapheme for that.
Segment::index_utf16() reports UTF-16 code units, never Rust UTF-8 byte positions.
is_word_like() is Some(bool) for words and None for graphemes/sentences.
Normalization supports NFC/NFD/NFKC/NFKD. Casing/trim follow JS semantics; engine
Unicode/ICU versions and locales can differ from Rust APIs. Invalid locales yield
InvalidLocale; empty locale selects the engine default. All handles are !Send/!Sync.
[Intl.Segmenter](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter/segment),
[normalization](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize),
[iterator protocol](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols).

With encoding, Decoder::new("shift_jis") returns Result<Decoder, InvalidEncoding>.
decode(&bytes) returns Result<JsString, DecodeError>. Labels follow WHATWG; each
call is complete/non-streaming, uses fatal decoding and preserves BOM. Invalid
labels and malformed input are recoverable. [TextDecoder](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder).

Thrown next/return errors preserve identity and follow Core fatal semantics.
Fatal traps or mem::forget may retain resources until host GC.

## Sizes and verification

Release opt-level=z/LTO, the same compact allocator, Binaryen 133 wasm-opt, Core
JSPI. Generated JS counts all runtime and application files; the Rolldown column
bundles them into one minified ESM, before gzip/Brotli. std/no_std use the same
corpus and oracle against both generated ESM and the Rolldown output.
Normalization tests four forms × 16 inputs; grapheme counting uses 16
inputs including combining characters, emoji and CRLF. This is not a universal
Unicode equivalence proof or performance ranking.

<!-- strings-size:begin -->
| Variant | no_std Wasm B | std Wasm B | Generated JS B | Rolldown JS B |
|---|---:|---:|---:|---:|
| unused | 575 | 575 | 1338 | 1209 |
| utf16-len | 507 | 507 | 2788 | 2249 |
| uppercase | 681 | 6692 | 2934 | 2394 |
| normalize | 718 | 6882 | 2963 | 2420 |
| rust-normalize | 121937 | 129032 | 1338 | 1209 |
| segment-count | 662 | 5738 | 3498 | 2734 |
| rust-grapheme-count | 28268 | 43166 | 1338 | 1209 |
| roundtrip | 623 | 6639 | 2873 | 2334 |
| decoder | 475 | 6657 | 3396 | 2744 |
| full | 8789 | 11854 | 5862 | 4845 |
<!-- strings-size:end -->

**Generated JS** sums the runtime, app bindings and selected helper `.mjs`
files. **Rolldown JS** bundles those files into one minified module. Subtract
`unused` in the same column to read the extra JS cost. Zero extra bytes means
no helper overhead, not zero JS for the application. Wasm columns are whole
fixture sizes.

`unused` enables all helper features but computes lengths in Rust, checking
that no helper JS is added. JS totals include the existing runtime and app
bindings. `utf16-len` includes input, length and Drop; `uppercase` includes input,
uppercase and UTF-8 output. The shared root infrastructure is a common cost
when any host-string feature is used.

full is a 16-operation diagnostic fixture using Rust format!, Vec and String to
check results, not a fixed library overhead. std also retains its panic, bounds
checks and unwrap paths. Host strings do not eliminate unrelated Rust formatting.

Run just strings-check; just compare-strings updates the [snapshot](strings-size.json)
with fixture locks and source hashes. just check/helpers-check include it. Other
checks cover std/no_std × JSPI/Future with the shared 3507-case/scheduling contract,
ownership across suspension, cancellation/drop, npm pack/install and strict TS.
Miri checks production Rust ownership/copy/Drop with a model host. Kani uses the
unchanged Root/JsIterator against an empty/single-item cursor model for any nonzero
u32 cursor ID, checking unstarted/early Drop, exhaustion, fused next and independent
item lifetime. It does not prove JS ICU/GC/iterators or Wasm codegen. Execution is
verified in V8/Node; Safari-target validation follows the [accepted WebKit E2E policy](browser-testing.md).
