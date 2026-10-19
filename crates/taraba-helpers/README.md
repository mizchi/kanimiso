# taraba-helpers

Optional JavaScript builtins for small Rust/Wasm libraries. `no_std`, no Rust
allocator or executor dependency. Enable only the helpers you use.

日本語: JS の標準機能を借りて Wasm を小さくする、オプションのヘルパーです。
`regexp`、JS 文字列、Unicode 正規化、Intl.Segmenter、TextDecoder、同期 Iterator を提供します。
`std` / `no_std`、Core JSPI / Future に対応します。文字列ヘルパーは使った関数と共通基盤だけを生成し、未使用なら追加 JS は 0 B です。

Cargo features enable Rust APIs; they do not force all JS into the bundle.
`taraba build` selects individual string, Iterator, Segmenter and Decoder
operations from imports remaining after wasm-opt. Unused helpers add 0 B of JS.
Used operations share root infrastructure; this common cost is included once
within each generated host. No extra npm dependency or manual binding is needed.

String helpers keep text in JS and expose lazy Rust iterators:

```toml
taraba-helpers = { version = "0.1.0", features = ["segmenter"] }
```

```rust
use taraba_helpers::{
    string::{JsString, Normalization},
    segmenter::{Segmenter, Granularity, InvalidLocale},
};
fn graphemes(text: &str) -> Result<usize, InvalidLocale> {
    let text = JsString::from(text).normalize(Normalization::Nfc);
    Ok(Segmenter::new("ja", Granularity::Grapheme)?.segment(&text).count())
}
```

`map` / `filter` / `take` / `collect` work as Rust Iterator adapters. Cursor and
items own independent JS roots; early Drop invokes optional JS `return()`.
`encoding` adds reusable fatal TextDecoder; `alloc` adds explicit Rust String
copies. [String guide / 文字列の使い方](https://github.com/mizchi/taraba/blob/main/docs/strings.ja.md).

Add the crate from crates.io (Rust 1.85+):

```toml
[dependencies]
taraba-helpers = { version = "0.1.0", features = ["regexp"] }
```

```rust
use taraba_helpers::regexp::{InvalidPattern, RegExp};

fn valid(text: &str) -> Result<bool, InvalidPattern> {
    let re = RegExp::new("^[a-z]+$")?;
    Ok(re.is_match(text))
}
```

Compile once outside repeated matching loops. `Drop` releases the JS object.
`taraba build` detects the private imports, validates the shipped WIT contract,
and includes the matching JS module automatically. Application WIT still describes
only the application's public interface. Instantiate normally and attach exports
before calling a generated method; no extra host bindings are needed.

This uses **JavaScript Unicode RegExp** (`u`, no `g`/`y`), not Rust `regex`
semantics or its linear-time guarantee. Syntax errors return `InvalidPattern`.
There is no captures/replacement/flags API yet. The private UTF-8 pointer ABI is
Core-only, not a Component Model string ABI; native WASI hosts are not supported.

[日本語の使い方・計測](https://github.com/mizchi/taraba/blob/main/docs/helpers.ja.md)
· [Guide and measurements](https://github.com/mizchi/taraba/blob/main/docs/helpers.md)
