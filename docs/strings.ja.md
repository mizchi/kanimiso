# JS に文字列を保持し、Rust Iterator で処理する

[English](strings.md) | 日本語

`taraba_helpers` の `JsString` は、JS 側に保持する文字列の所有ハンドルです。Unicode 正規化、大小文字変換、trim、コードポイントの走査、`Intl.Segmenter` の分割、`TextDecoder` のデコードを提供します。`std` / `no_std`、Core JSPI / Future に対応します。

Rust のアロケータも Future executor も依存に持ちません。文字列と Iterator の状態を JS に置き、Rust は各4 Bのハンドルを保持します。JS 側での allocation・デコード・文字列生成は発生します。

## 使う機能を選ぶ

crates.io の依存として使う例です（Rust 1.85 以上）。デフォルトではどのヘルパーも有効にしません。

```toml
[dependencies]
taraba-helpers = { version = "0.2.0", features = ["segmenter"] }
```

| feature | API |
|---|---|
| `strings` | `string::JsString`、正規化、大小文字変換、trim、比較、明示的な UTF-8 コピー |
| `iterator` | `iter::JsIterator<T>`。`strings` と併用すると `code_points()` |
| `segmenter` | `segmenter::Segmenter`。`strings` / `iterator` を自動で有効にする |
| `encoding` | `encoding::Decoder`。`strings` を自動で有効にする |
| `regexp` + `strings` | `RegExp::new_js` / `is_match_js`。JS 文字列を直接渡す |
| `alloc` | `JsString::to_rust_string()`。コピー先の Rust `String` が必要な場合だけ |

`values` はこれらが利用する共通ハンドル基盤です。アプリは必要な上位 feature を選びます。

## ビルドに含まれる処理

`taraba build` は wasm-opt 後の Wasm import を調べ、文字列・Iterator・Segmenter・Decoder の必要な関数だけを JS に生成します。Cargo feature は API を利用可能にする指定で、機能一式をバンドルする指定ではありません。全 feature を有効にしていても、ヘルパーを使わなければ追加 JS は 0 B です。

たとえば `JsString::from(text).utf16_len()` だけなら、UTF-8 入力と UTF-16 長の処理に加え、共通ハンドル基盤が入ります。正規化・大小文字変換・trim・TextEncoder・Iterator・Segmenter・Decoder モジュールは入りません。大文字変換・小文字変換・trim も個別に除去します。Segmenter で件数だけ数える場合は、要素の文字列・位置・word-like を読む処理を含めません。削除は JS バンドラーを使わずに生成段階で行い、CLI 単体で利用できます。ABI は引き続き同梱 WIT で検証します。

```rust
use taraba_helpers::string::JsString;

fn utf16_units(input: &str) -> u32 {
    JsString::from(input).utf16_len()
}
```

この例は `strings` feature だけで書けます。入力の UTF-8 デコードに `TextDecoder` を使いますが、別の文字コードを指定する `encoding::Decoder` は取り込みません。Rust 側では長さと所有ハンドルを扱い、文字列を Rust `String` へコピーしません。

共通ハンドル基盤は複数の操作で使い回します。各機能を単独で使う測定値を足して、複数機能を使う時のサイズとすることはできません。これは配布するコードの費用の説明で、JS 側の文字列生成や FFI が無料になるという意味ではありません。

公開するアプリの WIT と型付き host メソッドの使い方は従来通りです。ヘルパーの private WIT をアプリへコピーする必要はありません。公開 Core WIT の型制限は変わらず、`JsString` を canonical WIT `string` として export する機能ではありません。[Core と Component の選択](guide.ja.md)。

## コピーせずに文字列処理をつなぐ

```rust
use taraba_helpers::string::{JsString, Normalization};

let text = JsString::from("  Ａe\u{301}🦀  ")
    .normalize(Normalization::Nfkc)
    .trim()
    .to_uppercase();

let utf16_units = text.utf16_len();

// Rust 側で内容が必要になった時だけ、呼び出し側の buffer へコピーする。
let mut bytes = [0u8; 64];
let written = text.write_utf8(&mut bytes);
let copied = core::str::from_utf8(&bytes[..written]).unwrap();
```

`from(&str)` は同期 import 中に UTF-8 をデコードし、ポインタや view を保持しません。その後の正規化・変換・比較・RegExp 判定は JS の文字列を使います。`Clone` は同じ不変の JS 文字列に対する別の所有ハンドルを作り、`Drop` はそのハンドルを解放します。

`write_utf8` は buffer に入る完全な UTF-8 の prefix だけを書き、書き込んだ byte 数を返します。途中の Unicode scalar を切断せず、残りの buffer は変更しません。JS の UTF-16 を Rust の `&str` として直接借用する API ではありません。`utf8_len()` は現実装では JS 側に一時的なエンコード結果を生成します。

`to_rust_string()` は `alloc` feature で使えます。Rust 側の allocation と UTF-8 コピーが発生するため、最後まで JS に置ける処理では不要です。JS RegExp を使う場合も `RegExp::new_js(&pattern)` / `is_match_js(&text)` を選べます。

## Iterator の接続

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

この Iterator は関数を抜けて `text` / `segmenter` の Rust ハンドルが解放された後も使えます。JS の cursor 自体が必要な入力を保持します。返した各 `JsString` も cursor と独立した所有ハンドルです。

`JsIterator<T>` は JS の同期 Iterator を Rust の `Iterator` / `FusedIterator` に接続します。現在の型付き生成元は文字列の `code_points()`（要素は `JsString`）と `Segmenter::segment()`（要素は `Segment`）です。任意の生ハンドルから公開 API で構築することはできません。

| 操作 | 動作 |
|---|---|
| `next()` | JS `next()` を一度呼ぶ。取り出した要素だけに新しい所有ハンドルを付ける |
| 通常の終了 | cursor を解放。以降は JS を呼ばず常に `None` |
| 途中の `Drop` | cursor を先に解放し、任意の JS `return()` を呼ぶ。返り値は使わない |
| `map` / `filter` / `take` / `collect` | Rust の標準 adapter をそのまま使う |
| `.await` をまたぐ | cursor と取得済みの要素を保持できる。Future のキャンセル時も Drop する |

`count()` なども現時点では一要素ずつ FFI を通ります。Rust の predicate を使う合成に向く形で、JS のバルク処理より速いとは限りません。`collect::<Vec<_>>()` にはアプリ側の allocator が必要です。`JsIterator` 自体は Rust の allocation を必要としません。

## Unicode の単位とエラー

- `code_points()` は JS のコードポイント単位で、各要素は `JsString`。ユーザーが認識する一文字の分割には `Granularity::Grapheme` を使います。
- `Segment::index_utf16()` は入力の UTF-16 code-unit の位置です。Rust `&str` の byte index に使わないでください。
- `is_word_like()` は word 分割で `Some(bool)`、grapheme / sentence では `None` です。
- 正規化は NFC / NFD / NFKC / NFKD。大小文字変換と trim は JS の意味に従います。locale や Unicode/ICU バージョンはエンジンに依存し、Rust の同名 API との完全互換を主張しません。
- `Segmenter::new` の不正 locale は `InvalidLocale`。空文字列はエンジン既定 locale を選びます。
- ヘルパーのオブジェクトは `!Send` / `!Sync`。同じ instance / JS agent に属します。

[Intl.Segmenter](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter/segment)・[Unicode 正規化](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize)・[JS の Iterator protocol](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols)。

## 文字コードのデコード

```rust
use taraba_helpers::encoding::Decoder;

let decoder = Decoder::new("shift_jis"); // Result<Decoder, InvalidEncoding>
// decoder.decode(&bytes) -> Result<JsString, DecodeError>
```

WHATWG の encoding label を使い、Decoder を再利用できます。各 `decode` は一つの完全な入力として扱い、ストリーミングの途中状態は公開しません。不正なバイト列は `DecodeError` として返し、置換文字へ暗黙に変換しません。BOM は保持します。不正 label と不正入力から復帰でき、通常の結果として instance を使い続けられます。[TextDecoder](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder)。

JS Iterator の `next` / `return` 等が投げた例外は元のオブジェクトを伝播します。この場合は既存の Core の fatal 契約に従います。fatal trap や `mem::forget` で Drop が動かなかったオブジェクトは host が GC されるまで残る場合があります。

## サイズと検証

release / opt-level=z / LTO、同じ compact allocator、Binaryen 133 の wasm-opt、Core JSPI での値です。Wasm、生成された全 JS の合計、Rolldown で全 JS を ESM 一つにまとめ minify した値を分けています。gzip/Brotli 前の byte 数です。各 std/no_std 構成で同じ corpus・oracle を、生成 ESM と Rolldown 出力の両方で通します。正規化は4形式×16入力の64ケース、書記素数は絵文字・結合文字・CRLF等の16ケースです。Rust / JS の全 Unicode 入力での同等性や性能順位の証拠とは扱いません。

<!-- strings-size:begin -->
| 構成 | no_std Wasm B | std Wasm B | 生成 JS B | Rolldown JS B |
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

表の **生成 JS** は、ランタイム・アプリ bindings・選択されたヘルパーの `.mjs` ファイルの合計です。**Rolldown JS** はそれらを一つにバンドルした合計です。追加 JS の費用は、同じ列の `unused` との差で読みます。0 B というのはヘルパーによる増分で、アプリ全体の JS が 0 B になる意味ではありません。Wasm 列は各 fixture の全体サイズです。

`unused` は全ヘルパー feature を有効にして Rust だけで長さを数え、追加 JS がないことを確認する構成です。表の JS はヘルパーだけでなく既存ランタイムとアプリ bindings も含みます。`utf16-len` は文字列の入力・長さ・Drop、`uppercase` は入力・大文字変換・UTF-8 コピーを含みます。共通ハンドル基盤は、どれかの文字列機能を使う時の共通費です。

full は16操作の検査用 fixture で、結果の検査用に Rust の `format!`・Vec・String も使っています。ライブラリの固定費ではありません。標準の panic / bounds check / unwrap が残る std のサイズも含みます。文字列を JS に保持しても、呼び出し側が取り込む Rust の整形処理は削除しません。

`just strings-check` / `just compare-strings` で実行・スナップショット更新できます。[JSON](strings-size.json)には Cargo.lock と入力ハッシュを記録します。`just helpers-check` / `just check` もこの検証を含みます。追加で std/no_std × JSPI/Future の共通3507ケースと scheduling、中断中の文字列・cursor・取得済み要素の保持、Future キャンセル時の解放、npm pack/install と strict TS を検査します。

Miri は実際の Rust のハンドル・コピー・Drop をモデル host で検証します。Kani は実装の `Root` / `JsIterator` を読み込み、任意の非ゼロ u32 cursor ID と空／一要素の host モデルで、未開始 Drop・早期 Drop・通常終了・Fused・要素の独立した解放を検証します。JS の ICU・GC・Iterator 実装や Wasm コード生成全体の証明ではありません。V8/Node で実行し、Safari 実ブラウザーは未検証です。
