# Wasm のサイズを調べる

[English](insight.md) | 日本語

`taraba build` は整形マクロと Wasm の整形関数にサイズ警告を出します。最適化後の大きな関数や保持経路は `taraba insight` で調べます。解析は native CLI 内で動き、アプリの Rust/Wasm や JS に解析ライブラリは入りません。

```sh
taraba build --insight
taraba insight
taraba insight --paths fmt
taraba insight --retained --top 10
taraba insight --json > sizes.json
```

## ビルド時の警告

| 警告 | 意味 |
|---|---|
| `taraba::fmt-size` | ソースで `format!`、`write!`、`writeln!`、print 系、`format_args!`、`dbg!`、`fmt!` を検出。ファイル・行・列を表示 |
| `taraba::fmt-linked` | 入力 Wasm の名前から整形関数を検出。関数数と最適化前のコード量を表示 |
| `taraba::host-builtin` | Cargo の通常依存から、JS の標準機能への移譲を検討できるものをビルド前に表示。[候補・実装状況・計測](helpers.ja.md) |

警告はサイズ増加の候補です。`format_args!` だけで formatter がすべてリンクされるとは限らず、未使用コードは消えることもあります。最適化前のコード量を、そのマクロによる増加量や削減可能量とは扱いません。

ソース検出は Cargo の dep-info と構文木を使い、選択したライブラリのソースディレクトリ内を調べます。コメント・文字列は除外し、一般的な test / feature / debug assertions の cfg を考慮します。マクロ展開、別名の解決、`cfg_attr` の完全な評価は行いません。同名の独自マクロや未使用関数内にも候補が残り得ます。依存ライブラリ由来の整形は Wasm 側で調べます。

`.wasm` 入力ではソースを探さず、Wasm の警告だけを出します。名前を除去済みの関数や inline された処理は特定できないため、警告がなくても formatter がない証拠にはなりません。`taraba build --no-size-warnings` は taraba のサイズ警告だけを無効にします。

## 解析データと配布物

Core の `--insight` は最適化中の名前を保持し、次を生成します。

| ファイル | 用途 |
|---|---|
| `pkg/app.wasm` | 配布用。関数名 metadata は除去 |
| `pkg/.taraba/insight.wasm` | 最適化後の名前付き view。DWARF は除去 |
| `pkg/.taraba/insight.json` | 全関数のサイズ・保持関係の集計 |

名前付き view から name section だけを除いたバイト列が、対応する `app.wasm` と一致します。ディレクトリ入力では毎回照合し、古い解析データを拒否します。名前保持で Binaryen の index 順序が変わる場合があり、別に実行した通常ビルドとのバイト列同一までは保証しません。

```sh
taraba build --insight --npm-name @example/library
pnpm --dir pkg pack
```

`.taraba/` はローカルに残し、npm の `files` と配布サイズの集計から除外します。`--watch --insight` も利用できます。Cargo 出力ですでに名前を消している場合は復元できないため、解析用には release profile の `strip = false` を設定してください。

## 出力の読み方

既定の入力は `pkg/`。ディレクトリでは `.taraba/insight.wasm`、なければ `app.wasm` を読みます。`taraba insight input.wasm` のように明示したファイルは直接解析します。入力の変更やビルドは行いません。Component container は対象外で、個々の生成された Core Wasm を渡します。

| 項目・オプション | 意味 |
|---|---|
| Sections | ID・長さのヘッダー込み。全行と先頭8 Bの合計が入力サイズ |
| Shallow | 関数本体の長さ LEB・locals・命令を含むバイト数 |
| Retained | 関数参照グラフで、その関数が支配する関数のバイト数 |
| `--paths <文字列>` | 名前を部分一致で絞り、一つの最短の保持経路を表示 |
| `--retained` | retained 順。既定は shallow 順 |
| `--filter <文字列>` | 関数名の部分一致。正規表現ではない |
| `--top N` | 表示上限。既定20。JSON も同じ上限 |
| Groups | 名前による formatting / panic / allocator / other の概算分類。shallow の合計 |

export・start・table/global の関数参照を root とし、直接 call・`ref.func` 等を辿ります。動的な間接呼び出し先は推定せず、table/global の参照を保守的に root とします。経路は複数あり得ます。retained は data・型・その他の section を含まず、削減可能量ではありません。各 retained 行を合計しないでください。

JSON は `schema: 1`。`total_bytes` は解析入力全体、`name_bytes` は名前 section、`deployment_bytes` はディレクトリ入力に対応する配布 Wasm。`function_count`、`named_functions`、`matched_functions`、`sections`、`functions`、`groups`、`notes` を含みます。`retained_bytes: null` はこのグラフで root から到達しない関数です。

`wasmparser` 0.252.0 で GC・externref 等を読み、`twiggy-ir` 0.8.0 の demangle と dominator 解析を使います。旧 twiggy parser の externref table 制約を避け、twiggy 本体のインストールや Node.js は不要です。

`just insight-check` は JSPI/Future × std/no_std の通常版・解析付き版に共通3,507ケースとスケジューリング検証を実行し、format・警告・npm tarball 除外・古い view の拒否も確認します。`just check` に含み、`just package-check` では配布アーカイブの CLI でも検証します。Safari 向け検証には[WebKit E2E の方針](browser-testing.ja.md)を採用しています。

[開発・検証](development.ja.md) · [panic 通知](panic-reporting.md) · [twiggy / wasm-snip 実験](wasm-size-analysis.md)
