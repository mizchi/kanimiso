# JS の標準機能を借りて Wasm を小さくする

[English](helpers.md) | 日本語

`taraba-helpers`（Rust のパスは `taraba_helpers`）は、JS エンジンが持つ実装を借りるためのオプションのライブラリです。RegExp に加え、[JS 文字列・正規化・分割・Iterator・文字コード](strings.ja.md)を提供します。`std` / `no_std`、Core の JSPI / Future の両方で動き、Rust の allocator や executor を依存に持ちません。

`std` を有効にするだけで一定量が追加されるわけではありません。単純な数値処理は std/no_std とも Wasm 51 B でした。どの API を使い、どの整形・panic・データテーブルがリンクに残るかを調べます。

## 使用方法

crates.io の依存として追加します（Rust 1.85 以上）。

```toml
[dependencies]
taraba-helpers = { version = "0.2.0", features = ["regexp"] }
```

```rust
use taraba_helpers::regexp::{InvalidPattern, RegExp};

fn count_matches(texts: &[&str]) -> Result<usize, InvalidPattern> {
    let pattern = RegExp::new("^[a-z]+$")?;
    Ok(texts.iter().filter(|text| pattern.is_match(text)).count())
} // Drop で JS 側の RegExp を解放
```

通常通り `taraba build` します。private import を検出し、使う場合だけ `helpers-regexp.mjs` と接続コードを生成します。追加の npm 依存・手動の host bindings は不要です。アプリの WIT は公開インターフェースだけを記述します。`createHost` → 標準の `WebAssembly.instantiate(bytes, host.imports)` → `host.attach(instance.exports)` → 型付き `host.method(...)` という利用方法も同じです。

RegExp は一度生成して繰り返し使えます。Rust Future の `.await` をまたいで保持でき、タスクのキャンセルでは `Drop` が動きます。JSPI の中断・再開でも利用できます。文字列は private import の同期呼び出し中だけ借用し、JS が UTF-8 からデコードします。呼び出し終了後にポインタやメモリの view を保持しません。`memory.grow` 後は新しい buffer を参照します。

各 RegExp は 4 B の handle を Rust に置き、JS の Map に実体を保持します。clone/raw handle の公開 API はなく、`!Send` / `!Sync` です。`mem::forget` や fatal trap で Rust の Drop が動かない場合、JS のオブジェクトは host が GC されるまで残ることがあります。JS 側の allocation や UTF-8 デコードのコストがなくなるわけではありません。

## 使う機能だけを含める

デフォルトの Cargo feature は空です。feature は Rust API を利用可能にする指定で、JS の機能一式を取り込む指定ではありません。

| 選ぶ feature | 使える機能 | JS の選択単位 |
|---|---|---|
| `regexp` | `RegExp::new` / `is_match` | RegExp モジュール。未使用ならファイルも接続コードも生成しない |
| `strings` | `JsString`、正規化、大小文字変換、trim、比較、UTF-8 コピー | wasm-opt 後に import が残った関数だけ |
| `segmenter` | grapheme / word / sentence 分割と Rust Iterator | 分割・走査・要素の取得を関数ごとに選択 |
| `encoding` | `TextDecoder` による文字コード変換 | Decoder と使用する文字列関数だけ |
| `alloc` | `JsString::to_rust_string()` | Rust `String` への明示的なコピーを使う時だけ |

全 feature を有効にしても、ヘルパーを使わなければ追加 JS は **0 B** です。文字列機能を使うと共通ハンドル基盤が加わり、各操作は同じ基盤を使います。正規化・大小文字変換・trim は個別に除去されます。Segmenter の `count()` だけなら、要素の文字列・位置・word-like を読む関数は含めません。

関数の選択は `taraba build` の生成段階で完了するため、利用者が JS バンドラーを追加する必要はありません。Rust のポインタを借用する範囲、Iterator の Drop、コピーの費用は[文字列と Iterator のガイド](strings.ja.md)を参照してください。[文字列のサイズ表](strings.ja.md#サイズと検証)には生成 JS と Rolldown 出力を分けて載せています。

## サイズ比較

後述のスナップショットでは、共通のパターン 8 種・文字列 14 種・反復回数 4 種の **同じ 448 ケース**を通します。各実装は「選択されたパターンを一度 compile → 指定回数 is_match → drop」の同じ Rust 制御フローを使います。Core JSPI、同じ allocator、release `opt-level=z` / LTO と Binaryen 133 の `wasm-opt -Oz` です。性能順位は測っていません。

<!-- helpers-regex:begin -->
| 構成 | Wasm B | JS B | 合計 B |
|---|---:|---:|---:|
| regex 1.13.1 default / std | 771150 | 1338 | 772488 |
| regex 1.13.1 std only / std | 234711 | 1338 | 236049 |
| taraba-helpers / std | 818 | 2590 | 3408 |
| taraba-helpers / no_std | 818 | 2590 | 3408 |
<!-- helpers-regex:end -->

JS には共有 runtime・アプリの生成コード・ヘルパーをすべて含めます。RegExp ヘルパー単体は 611 B です。使わないアプリではこのファイルも接続コードも生成せず、既存の runtime.mjs は同じ内容です。同じ URL の ESM を使う場合の共有については [ESM キャッシュ](esm-cache.ja.md)を参照してください。

Rust `regex` の default features を無効化する対照も含めています。これはこの corpus を通す最小寄りの設定であり、任意の Unicode property・case folding や性能設定が同じという意味ではありません。

## どこで増えるか

以下は**個別機能のプローブ**です。正規表現の表とは異なり、異なる行同士で同じアルゴリズムを比較する表ではありません。単位は B、最適化後の Wasm 全体です。std/no_std の組は同じ処理・テストで、no_std の panic handler は `unreachable` です。

<!-- helpers-audit:begin -->
| プローブ | Wasm B | code B | data B |
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

`taraba build` は Cargo metadata から選択したアプリの通常依存をたどり、`regex`、`serde_json`、`url` / `idna`、`chrono` / `time`、Unicode 正規化、汎用 executor などを**ビルド前に確認候補として警告**します。dev/build 依存だけのものや別の workspace member は対象にしません。依存の存在は保持サイズの証拠ではなく、feature 解決の情報も診断の手がかりです。`--no-size-warnings` でこの警告と整形マクロの警告を抑制できます。

```sh
taraba build --insight
taraba insight --retained --top 20
taraba insight --paths regex
taraba insight --paths fmt
```

`insight` は最適化後の関数のサイズ・保持経路とセクションを表示します。regex / JSON / URL・Unicode / 日時 / collections / executor の名前ベースのグループも追加しています。これは crate 単位の厳密な帰属ではありません。インライン化・共有関数は別の名前に入り、Unicode テーブルやエラー文字列などの data は関数サイズに含みません。code と data を分けて確認します。例えば今回の URL プローブは data が約 101 KB、regex 既定版は約 351 KB あり、関数だけを削っても全体は説明できません。

表の code/data は section header を含む実サイズです。全体には型・import/export 等も含まれます。

## 次の候補と選択条件

| 処理 | 借りられる JS 機能 | 決める必要のある契約 | 実装状況 |
|---|---|---|---|
| 正規表現 | `RegExp` | JS の Unicode 構文・計算量、フラグ | compile / is_match / Drop を提供 |
| JSON | `JSON.parse` / `stringify` | i64/u64 の精度、schema、JS に値を保持するか Rust へコピーするか | 未実装 |
| URL・IDNA | `URL` / `URLSearchParams` | WHATWG URL、相対 URL の base、正規化とバージョン差 | 未実装 |
| 日時 | `Date` / `Intl` | ミリ秒精度、timezone、locale、対応する暦 | 未実装 |
| Unicode 正規化 | `String.normalize` | NFC/NFD 等、エンジンの Unicode バージョン、返り値の所有権 | [JsString::normalize](strings.ja.md) |
| 数値の文字列化 | `String(number)` / `toFixed` | f64 の精度、Rust の表示形式との違い、i64/u64 の扱い | 未実装 |
| Map / Set | `Map` / `Set` | Rust の Hash/Eq、キーの JS identity、値の所有権 | 未実装 |
| 非同期・タイマー | Promise / イベントループ | JSPI の直列実行、Future の並行・キャンセル、外部 I/O | taraba の既存 API を使う |

コレクションや文字列だけなら `alloc` で足りることがあります。`std::fs` / `net` / `thread` は wasm32-unknown-unknown でそのままブラウザーの機能になりません。fetch・タイマー等の host I/O は WIT で明示します。すべてを JS へ転送すると FFI 回数や変換コストが増えるため、細かなループや Rust 固有の型を扱う処理まで無条件に置き換えません。

## RegExp の契約と検証範囲

JS RegExp の `u` flag を固定し、`g` / `y` は使わないため、繰り返し判定が `lastIndex` に依存しません。構文エラーはゼロサイズの `InvalidPattern` として返します。captures・replace・任意のフラグ・マッチ位置の API はまだありません。

Rust `regex` と構文・Unicode class・アンカーなどが異なり、完全互換ではありません。Rust `regex` の worst-case `O(m*n)` の検索保証を JS RegExp の契約に引き継ぎません。JS と Rust の offset（UTF-16 / UTF-8）の違いを隠す API も提供しません。[Rust regex の契約](https://docs.rs/regex/1.13.1/regex/)・[JS Unicode モード](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/unicode)・[lastIndex](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/lastIndex)。

JS の backtracking と線形時間エンジンの違いは [V8 の解説](https://v8.dev/blog/non-backtracking-regexp)も参照してください。特定のエンジン最適化を、このライブラリの計算量保証とは扱いません。

private ABI は [version 付き WIT](../crates/taraba-helpers/wit/regexp.wit) からビルド時に検証します。これは明示的な UTF-8 ptr/len の **Core memory ABI** で、Component Model の canonical string/resource ABI ではありません。現時点では `--component` と JS のない WASI host を対象にしません。

`just helpers-check` でサイズプローブ、共通 regex テスト、std/no_std × JSPI/Future の 3507 ケースと scheduling、Future キャンセル時の RegExp 解放、npm pack/install・strict TS を検証します。`just compare-helpers` で[機械可読スナップショット](helpers-size.json)とこの表を更新します。スナップショットには fixture ごとの Cargo.lock と入力ハッシュを保存します。

Miri は Rust 側の借用・Drop をモデル host で確認します。Kani は実装の RegExp API とモデル FFI を使い、全 u32 handle（0 の失敗を含む）と真偽の結果について所有権と一度だけの解放を native64 で検証します。JS の正規表現エンジン・Map・Wasm ポインタ全体の証明ではありません。V8/Node で実行し、Safari 実ブラウザーは未検証です。
