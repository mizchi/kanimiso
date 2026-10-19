# taraba

[English](README.md) | 日本語

Rust でフロントエンドのミドルウェアを書くには、Wasm の配布サイズや非同期処理に伴うランタイムオーバーヘッドを減らす必要がありました。

**taraba は、専用アロケータと最新の Wasm 仕様を使い、JavaScript のイベントループを前提とすることで、そのオーバーヘッドを限りなく小さくすることを目指す Rust/Wasm ランタイムです。**

WIT から async を含むライブラリを作り、Component または型定義付き npm パッケージとして配布できます。軽量な Core/JSPI と、並行実行・キャンセルを扱う既存 Future ランタイムも選べます。旧名は `kanimiso` です。

| 必要なもの | 実行方式 | 配布形式 |
|---|---|---|
| WIT async・record・string・list・型付きドメイン値 | `--component` | Component Model の成果物 |
| 同じ API を TS 型定義付き npm ライブラリにする | `--component` | `--npm-name @scope/library` を追加 |
| 数値 API（s32/u32/f64）の省サイズな JS ライブラリ | 既定 / `--jspi` | Core Wasm + JS。npm 化も可能 |
| Rust Future の並行実行・spawn_local・キャンセル | `--future` | Core Promise/resource ランタイム。npm 化も可能 |

WIT から型付き async を書く場合は Component、数値 API のサイズを優先する場合は JSPI を選びます。`new` と `build` で同じ実行方式を指定してください。Component は Canonical ABI、Core は JS 向けの独自 ABI です。npm 化は、それとは別に選択できます。

## 利用開始

初回 crates.io 公開を準備しており、まだ未公開です。以下は公開後の利用手順で、現在は .crate と外部アプリで検証しています。[インストールと前提ツール](docs/guide.ja.md#インストール)を参照してください。

```sh
cargo install taraba-cli --version 0.1.0 --locked
rustup target add wasm32-unknown-unknown
# Component ビルド用に Binaryen 133 と wasm-tools 1.245.1 を用意する
taraba new hello --component --no-std
cd hello
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/hello.wasm --wit wit --component
```

`wit/app.wit` に `async func` を書き、生成された Rust の `Guest` trait を `async fn` で実装すると、`pkg/app.component.wasm` を生成できます。`--npm-name @example/hello --npm-version 0.1.0 --license MIT` を追加すると、JS・TS 型定義・必要な Wasm・`package.json` まで生成します。Component の npm 化には jco 1.39.0 も必要です。`pnpm pack` で tarball を作れます。ビルドは publish を行いません。

<!-- async-size:begin -->
## ビルドサイズ比較

同じ二段 await の Rust 実装、std、taraba-allocator（size classes 無効）。JS は minify、全 Wasm は wasm-opt -Oz 適用後の非圧縮 bytes。全34成果物が同じ3,507ケースを通過。

| 構成 | async Wasm B | async JS B | 合計 B | 同期版からの増分 B |
|---|---:|---:|---:|---:|
| taraba JSPI | 5,263 | 1,402 | 6,665 | +4,545 |
| taraba Future | 6,871 | 4,007 | 10,878 | +6,153 |
| Embassy WASM + JsFuture | 13,360 | 5,211 | 18,571 | +16,710 |
| wasm-bindgen-futures | 15,221 | 4,442 | 19,663 | +17,802 |
| Tokio current-thread + LocalSet | 52,721 | 4,442 | 57,163 | +55,302 |
| async-executor LocalExecutor | 32,324 | 4,442 | 36,766 | +34,905 |
| async-std spawn_local | 17,930 | 4,442 | 22,372 | +20,511 |
| FuturesUnordered task set | 18,495 | 4,440 | 22,935 | +21,074 |
| Component + jco | 25,350 | 66,776 | 92,126 | +38,986 |

JSPI は instance を直列実行し、Component は型付き WIT async / Canonical ABI を含むため、API 契約は異なります。FuturesUnordered はタスク集合の参考値です。Component container は実行用 core Wasm と二重計上していません。[追加ランタイムの構成・no_std・圧縮・wee_alloc 対照・測定条件](docs/async-size.ja.md)。
<!-- async-size:end -->

## ドキュメント

- [利用ガイド](docs/guide.ja.md): インストール、WIT/Rust async、ドメインモデル例、Node/browser のロード、TS、npm、編集から配布までの手順。
- [Core API リファレンス](docs/core-runtime.ja.md): JSPI/Future の契約、所有権、task 上限とエラー。
- [JS ランタイムの共有](docs/esm-cache.ja.md): 複数の Core ライブラリを共通 ESM チャンクに集約し、instance の状態を分離する検証。
- [現在の非同期サイズ比較](docs/async-size.ja.md): taraba・Embassy・Tokio・async-executor・async-std・wasm-bindgen-futures、FuturesUnordered 参考値の同等処理。同期→async 増分と必要な全 JS/Wasm を計上。
- [ドキュメント一覧](docs/README.ja.md): 過去の測定と未採用の実験。
- [開発・検証手順](docs/development.ja.md): テスト、パッケージ検証、測定の再実行。

JavaScript の async は Safari 27+ / JSPI 対応 V8 を前提とします。Safari 実機と native Component host の実行はここでは未検証です。Component async/jco は upstream でも実験扱いです。JSPI は I/O 待ちも含めて instance を直列化し、reject/trap を fatal とします。任意の Rust Future を駆動する executor ではなく、Future 構成や標準 Component toolchain とは契約が異なります。

CLI/runtime/JS は MIT、任意で使う allocator は MPL-2.0。[来歴とライセンス](THIRD_PARTY.md)。
