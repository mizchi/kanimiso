# taraba

[English](README.md) | 日本語

**WebAssembly のフットプリントに最適化した、Rust 向けの async runtime と allocator。**

Rust でフロントエンドのミドルウェアを書くために、Wasm と JavaScript の配布サイズを小さくします。専用の `taraba-allocator` と最新の Wasm 仕様を使い、非同期処理は JavaScript の Promise とイベントループに委ねます。std / no_std に対応します。

正規表現や文字列処理を JS の標準機能に委ねる [`taraba-helpers`](docs/helpers.ja.md) も用意しています。文字列ヘルパーは使う関数と共通基盤だけを生成し、未使用なら追加 JS は 0 B です。

## 最小サンプル

**JSPI（JavaScript Promise Integration）** は、Wasm の実行を中断し、JS の Promise が完了したら同じ場所から再開するエンジンの機能です。taraba はこれを既定で使います。Rust から JS の非同期関数を呼び、JS 側からは `await` で結果を受け取れます。待機中に JS のイベントループをブロックしません。[JSPI の仕組み](https://v8.dev/blog/jspi)。

Rust 1.85 以上で CLI と Wasm のターゲットを用意し、プロジェクトを作成します。ビルドには Binaryen 133 のツールを PATH に配置してください。[インストールの詳細](docs/guide.ja.md#インストール)。

```sh
cargo install taraba-cli --version 0.1.0 --locked
rustup target add wasm32-unknown-unknown

taraba new hello
cd hello
```

`wit/app.wit` で、JS から受け取る関数と公開する関数を定義します。

```wit
package taraba:app@0.1.0;
world app {
    import add: func(a: s32, b: s32) -> s32;
    export run: func(a: s32, b: s32) -> s32;
}
```

`src/lib.rs` の実装です。雛形の allocator 設定と panic handler はそのまま使います。

```rust
wit_bindgen::generate!({ path: "wit", world: "app" });

struct App;
impl Guest for App {
    fn run(a: i32, b: i32) -> i32 {
        let first = add(a, b); // JS の Promise が解決するまで JSPI が中断する
        add(first, 1)
    }
}
export!(App);
```

Rust の関数は同期形で書き、Promise 待機を JSPI が担当します。`taraba build` が Cargo の release / wasm32-unknown-unknown ビルドと、最適化・JS・TS 型定義の生成まで実行します。既定は `Cargo.toml`・`wit/`・出力先 `pkg/` です。

```sh
taraba build
```

生成物は、そのまま npm パッケージとして配布できる `pkg/` に出力されます。

```text
pkg/
├── index.js          # createHost を公開する ESM エントリー
├── index.d.ts        # WIT から生成する型定義
├── app.wasm
├── runtime.mjs
├── runtime.d.mts
├── package.json
└── wit/
```

package.json の名前・バージョン・ライセンスは、選んだ Cargo package の `name`・`version`・`license` を引き継ぎます。ライセンス未指定なら `UNLICENSED` です。`--npm-name @scope/library`、`--npm-version`、`--license` で個別に上書きできます。

`pkg/` で `pnpm pack` すれば配布用 tarball を作れます。npm へ公開する場合も `pkg/` で `pnpm publish --access public` を実行します。`taraba build` 自体は公開しません。[配布の詳細](docs/guide.ja.md#生成する-npm-パッケージ)。

次を `main.mjs` に保存し、Node.js 24+ の `node main.mjs` で呼び出せます。

```js
import { readFile } from 'node:fs/promises';
import { createHost } from './pkg/index.js';

const host = createHost({
    bindings: { add: async (a, b) => (a + b) | 0 },
});
const { instance } = await WebAssembly.instantiate(
    await readFile(new URL('./pkg/app.wasm', import.meta.url)),
    host.imports,
);
host.attach(instance.exports);
console.log(await host.run(20, 21)); // Promise<number> → 42
```

`taraba build` は WIT から `AppBindings` と `AppHost` を生成します。TypeScript と JS のエディターで `bindings` の引数・戻り値と `host.run(...)` を推論し、存在しないメソッドや誤った引数を型エラーにします。npm 出力も同じ API です。

Wasm の読み込みと生成は標準の `WebAssembly.instantiate` が担当します。taraba は import と安全な呼び出しを提供します。`host` ごとに一つの instance を接続し、export は `host.run(a, b)` のように直接呼びます。

開発中は `taraba build --watch` で Rust・WIT・ローカル依存を監視し、Cargo のコンパイルから成果物の生成まで自動実行できます。

## JSPI と Future はどう選ぶか

**JS から渡した非同期関数を Rust 内で順番に待つだけなら、既定の JSPI で扱えます。** 上のサンプルの `add` がその例です。Rust は同期形の関数を書き、Promise を待つ間の中断・再開を Wasm エンジンに任せます。

Rust の **Future** は、完了するまで待機と再開を繰り返す非同期の計算です。Future 構成はそれを駆動する taraba の executor を組み込みます。Rust 側に既存の `async fn` / `.await` の処理を持ち込みたい、複数の Future を並行して進めたい、またはタスクを明示的にキャンセルしたい場合に選びます。

| やりたいこと | 選ぶ構成 | 理由 |
|---|---|---|
| JS の async 関数を順に呼び、その結果で計算する | JSPI（既定） | Promise の待機・再開をエンジンに任せられる |
| Rust の Future を `.await`、join / select、`spawn_local` で組み合わせる | Future | Rust 内で待機中のタスクを保持・再開する executor が必要 |
| ある呼び出しの I/O 待ち中に、同じ instance の別の呼び出しも進める | Future | JSPI 構成は I/O 待ちを含めて instance ごとに直列実行する |
| Rust タスクをキャンセルする、Promise の失敗を task ごとに処理する | Future | task の寿命と `Result` を Rust 側で扱える |
| WIT の `async func` と record / string / list を持つ型付き API を作る | `--component` | 標準の Component Model と wit-bindgen / jco を使う |

JSPI と Future はどちらも std / no_std に対応します。JSPI の host reject / Wasm trap は instance を閉じます。Future のタスクにはサイズ・個数の上限があり、キャンセルは host のネットワーク通信の中止を自動では行いません。[実行契約と制限](docs/core-runtime.ja.md)。

`taraba new app --future` で Future 用の雛形を作れます。その後の `taraba build` / `taraba build --watch` は、生成 Wasm のランタイム import/export と WIT resource から JSPI/Future を自動選択します。Rust ソース中の `async` / `Future` の有無では判定しません。`--jspi` / `--future` は強制指定、`--component` は Component 出力の指定です。Core は既定で npm 形式を生成し、`--npm-name @scope/library` でパッケージ名を変更できます。Component の npm 出力には `--npm-name` を指定します。Component の npm 出力は jco が JS / TS を生成します。[利用ガイド](docs/guide.ja.md)。

## どれくらい小さいか

同じ二段の Promise 待機・加算を行う共通の Rust 実装で比較しています。各構成は同じ3,507ケースを通過。taraba-allocator（size classes 無効）を共通で使い、wasm-opt -Oz と JS minify を適用した非圧縮サイズです。1 kB = 1,000 bytes。

| 構成 | taraba の実行オプション | Rust | Wasm kB | JS kB | 合計 kB |
|---|---|---|---:|---:|---:|
| taraba JSPI | 自動（強制指定は `--jspi`） | std | 5.227 | 1.095 | **6.322** |
| taraba JSPI | 自動（強制指定は `--jspi`） | no_std | 0.248 | 1.095 | **1.343** |
| taraba Future | 自動（強制指定は `--future`） | std | 6.803 | 3.629 | **10.432** |
| taraba Future | 自動（強制指定は `--future`） | no_std | 1.712 | 3.629 | **5.341** |
| Component + jco | `--component` | std | 25.314 | 66.776 | **92.090** |
| Component + jco | `--component` | no_std | 13.691 | 66.776 | **80.467** |
| wasm-bindgen-futures | — | std | 15.185 | 4.442 | **19.627** |
| wasm-bindgen-futures | — | no_std | 9.783 | 4.442 | **14.225** |

Core の実行方式はビルド時に自動選択します。Component の場合は `taraba build --component` を指定します。std が既定で、no_std は `taraba new --no-std` で選びます。Component + jco は JS 向け npm 出力（`--npm-name` を追加）の値で、必要な全 core Wasm と JS を計上しています。Component 単体のサイズは[詳細な測定結果](docs/async-size.ja.md#npm-と-component-の配布物)を参照してください。

上の最小例と同じ処理を行う計測用 fixture の実測値です。アプリ全体のサイズであり、固定のランタイム費用ではありません。JSPI・Future・Component では並行実行やエラーの契約が異なります。

ビルド時に `format!` / `write!` などのサイズ警告を出します。`taraba build --insight` の後、`taraba insight --paths fmt` で最適化後の大きな関数と保持経路を調べられます。[解析の使い方](docs/insight.ja.md)。

<details>
<summary>全ランタイムの内訳と測定条件</summary>

<!-- async-size:begin -->
## ビルドサイズ比較

同じ二段 await の Rust 実装、std、taraba-allocator（size classes 無効）。JS は minify、全 Wasm は wasm-opt -Oz 適用後の非圧縮 bytes。全34成果物が同じ3,507ケースを通過。

| 構成 | async Wasm B | async JS B | 合計 B | 同期版からの増分 B |
|---|---:|---:|---:|---:|
| taraba JSPI | 5,227 | 1,095 | 6,322 | +4,545 |
| taraba Future | 6,803 | 3,629 | 10,432 | +6,121 |
| Embassy WASM + JsFuture | 13,324 | 5,211 | 18,535 | +16,710 |
| wasm-bindgen-futures | 15,185 | 4,442 | 19,627 | +17,802 |
| Tokio current-thread + LocalSet | 52,689 | 4,442 | 57,131 | +55,306 |
| async-executor LocalExecutor | 32,288 | 4,442 | 36,730 | +34,905 |
| async-std spawn_local | 17,894 | 4,442 | 22,336 | +20,511 |
| FuturesUnordered task set | 18,459 | 4,440 | 22,899 | +21,074 |
| Component + jco | 25,314 | 66,776 | 92,090 | +38,986 |

JSPI は instance を直列実行し、Component は型付き WIT async / Canonical ABI を含むため、API 契約は異なります。FuturesUnordered はタスク集合の参考値です。Component container は実行用 core Wasm と二重計上していません。[追加ランタイムの構成・no_std・圧縮・wee_alloc 対照・測定条件](docs/async-size.ja.md)。
<!-- async-size:end -->

</details>

## JS の標準機能を必要な分だけ使う

`taraba-helpers` は、正規表現や Unicode の実装を Wasm に持ち込まず、JS エンジンの標準機能を使うためのオプションです。crates.io の依存として追加します（Rust 1.85 以上）。

```toml
[dependencies]
taraba-helpers = { version = "0.1.0", features = ["strings"] }
```

```rust
use taraba_helpers::string::JsString;

fn utf16_units(input: &str) -> u32 {
    JsString::from(input).utf16_len()
}
```

通常通り `taraba build` するだけで接続されます。Cargo feature は Rust API を有効にする指定です。ビルドは wasm-opt 後の import を調べ、文字列・Iterator・Segmenter・Decoder の使う関数だけを生成します。ヘルパーが未使用なら追加 JS は **0 B** です。

| 処理 | feature | 生成する処理の範囲 |
|---|---|---|
| 文字列長を読む | `strings` | UTF-8 入力・UTF-16 長・ハンドル解放。正規化・大小文字変換・TextEncoder は含めない |
| 正規化する | `strings` | 入力・正規化。UTF-8 出力は `write_utf8` 等を使った時だけ |
| 分割件数を数える | `segmenter` | 入力・分割・Iterator。要素の文字列・位置・word-like の取得は含めない |
| 文字コードを変換する | `encoding` | 指定した文字コードの Decoder と、使う文字列操作 |

使用時には共通ハンドル基盤も入ります。これは最初の文字列機能を使う時の共通費で、各 API の費用として足し合わせるものではありません。`std` / `no_std`、Core JSPI / Future に対応します。公開 WIT と `host.method(...)` の使い方は同じで、手動の JS bindings は不要です。

[文字列・Iterator の使い方とサイズ表](docs/strings.ja.md)では Wasm、生成 JS、Rolldown 出力を分けて記録しています。Component / JS のない WASI host 向けのヘルパーではありません。

## Why

フロントエンドのライブラリは、別のライブラリに組み込まれ、依存グラフの深い場所で使われます。そこで数十 kB のランタイムが増えると、小さな処理のためには採用しづらくなります。アプリ本体が許容できるオーバーヘッドでも、再利用されるミドルウェアでは選択肢から外れる理由になります。

taraba は、Rust で書いた処理をフロントエンドの依存として選べるサイズに収めるためのライブラリです。サイズ感の参考として、代表的な JS ライブラリの小さな利用例を同じ Rolldown で計測しました。

| ライブラリ | バージョン | 測定した利用例 | minify kB | minify + gzip kB |
|---|---|---|---:|---:|
| React (core) | 19.3.1 | createElement / useState。renderer なし | 1.916 | 0.934 |
| React + React DOM | 19.3.1 | span を DOM に描画 | 220.025 | 67.524 |
| Preact | 11.0.1 | span を DOM に描画 | 10.598 | 4.535 |
| Zod | 4.6.7 | `{ name: string }` の検証 | 83.101 | 22.759 |
| Hono | 4.13.13 | 1本の GET route | 18.228 | 7.410 |
| Valibot | 1.5.0 | `{ name: string }` の検証 | 2.909 | 1.169 |

2026-10-19、Rolldown 1.2.14、production / ES2022 / ESM、gzip level 9。用途ごとの小さな entry のサイズであり、パッケージ全体や機能が同じ実装同士の性能比較ではありません。上の taraba 表と比べる場合は、非圧縮の minify 列を使います。[ソース・条件・再現方法](docs/frontend-size.md)。

**JSPI の JS は約1.1 kBで、その大部分のランタイムは複数の taraba ライブラリで共有できます。** 同じ profile のランタイムを共通 ESM チャンクへ集約し、同じ URL から読み込めば、一度のロード・評価で使い回せます。既定のパッケージ別コピーは自動共有されないため、[Rolldown による集約](docs/esm-cache.ja.md)を行います。表の1.095 kBはアプリ用 wrapper を含む値で、共有するランタイム単体は別計測で0.975 kBです。各アプリの wrapper・Wasm と instance の状態は個別です。

共有ランタイムは `createHost` だけを公開し、`index.js` は型付きのアプリメソッドを生成します。Wasm の生成・ロードには標準の WebAssembly API を使います。

**JS に通信・タイマーなどの I/O を任せ、Rust が計算・検証・変換を担うなら、まず no_std で始められます。** no_std でも [`alloc`](https://doc.rust-lang.org/stable/alloc/) と allocator により `Vec`・`String`・`Box` を使え、Future 構成も利用できます。std を要求する依存がなければ、ミドルウェアのロジックのために std を同梱する必要はありません。二段加算の計測用 fixture は no_std + JSPI で Wasm 248 Bとなり、共通 JS を一度配信した後の追加分を小さくできます。実際のロジックや依存、allocator を使用すれば、そのコードも加わります。

no_std は境界で扱える型を増やすオプションではありません。現在の Core/JSPI の境界は数値（s32/u32/f64）が対象です。文字列や record / list を公開 API として直接渡す場合は、型付きの Component 構成を選びます。

`taraba-allocator` は単独でも使える、wee_alloc 由来の軽量 allocator です。サイズ優先と、小さな確保の性能を重視する構成を選べます。[allocator の構成と比較](docs/guide.ja.md#allocator-の構成を選ぶ)。

## ドキュメント

- [利用ガイド](docs/guide.ja.md): インストール、WIT/Rust async、ドメインモデル例、Node/browser のロード、TS、npm、編集から配布までの手順。
- [Core API リファレンス](docs/core-runtime.ja.md): JSPI/Future の契約、所有権、task 上限とエラー。
- [エラーコード](docs/error-codes.md): ランタイムエラーの原因と対処。
- [JS ランタイムの共有](docs/esm-cache.ja.md): 複数の Core ライブラリを共通 ESM チャンクに集約し、instance の状態を分離する検証。
- [現在の非同期サイズ比較](docs/async-size.ja.md): taraba・Embassy・Tokio・async-executor・async-std・wasm-bindgen-futures、FuturesUnordered 参考値の同等処理。同期→async 増分と必要な全 JS/Wasm を計上。
- [ドキュメント一覧](docs/README.ja.md): 過去の測定と未採用の実験。
- [開発・検証手順](docs/development.ja.md): テスト、パッケージ検証、測定の再実行。

JavaScript の async は Safari 27+ / JSPI 対応 V8 を前提とします。Safari 実機と native Component host の実行はここでは未検証です。Component async/jco は upstream でも実験扱いです。JSPI は I/O 待ちも含めて instance を直列化し、reject/trap を fatal とします。任意の Rust Future を駆動する executor ではなく、Future 構成や標準 Component toolchain とは契約が異なります。

CLI/runtime/JS は MIT、任意で使う allocator は MPL-2.0。[来歴とライセンス](THIRD_PARTY.md)。

生成 npm には MIT/MPL の通知と、allocator の版を指定したソース取得先を同梱します。
アプリ自身のライセンスは別です。別版・改変版の MPL 対象依存を使う場合は通知を更新してください。
[ライセンスと来歴](https://github.com/mizchi/taraba/blob/main/THIRD_PARTY.md)を参照してください。
