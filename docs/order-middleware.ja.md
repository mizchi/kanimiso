# 注文ミドルウェア：実用例と計測

[English](order-middleware.md) | 日本語

URL・HTTP・JSON は JS の標準 API、注文の検証・正規化・金額計算は Rust、認可は async host import に分担する。[実装と実行手順](../examples/order-middleware/README.md)。永続化する注文サーバーではなく、Request → 検証・見積もり → Response のミドルウェアである。

同じ [WIT](../examples/order-middleware/wit/app.wit) と [Rust の業務ロジック](../examples/order-middleware/src/workflow.rs)を Core Future と標準 wit-bindgen Component でビルドする。独立した JS 実装にも同じ HTTP アダプター・認可処理・期待値を使う。各構成 196 ケース、並行数32。エラーと正常系の混在、Unicode、重複 SKU、価格衝突、u32 オーバーフローを含む。

計測日 2026-10-21。Node v24.21.0 / V8 13.6.233.17-node.53、Apple M5。

## 配布サイズ

| 実装 | Rust | Wasm | JS | 合計 |
|---|---|---:|---:|---:|
| javascript | host | 0 B | 3014 B | 3014 B |
| taraba | no_std | 6942 B | 6593 B | 13535 B |
| taraba | std | 11014 B | 6593 B | 17607 B |
| wit-bindgen | no_std | 15411 B | 85065 B | 100476 B |
| wit-bindgen | std | 26024 B | 85065 B | 111089 B |

JS は HTTP/URL/JSON アダプターと共有ランタイムを含めて Rolldown で縮小する。Wasm は -Oz / LTO、同じ taraba-allocator（size classes 無効）。Component は jco の接続コードと実行する全 core Wasm を計上し、Component コンテナを重複して加算しない。認可ポリシーは共通のアプリ注入で、ネットワーク待ち時間は計測しない。JS 行に std/no_std の違いはない。

## 初期化と HTTP 全体の時間

| 実装 | Rust | 新規 module/instance | 32明細 HTTP / 並行1 |
|---|---|---:|---:|
| javascript | host | 0.094 ms | 31.34 µs |
| taraba | no_std | 0.520 ms | 63.13 µs |
| taraba | std | 0.919 ms | 62.76 µs |
| wit-bindgen | no_std | 1.626 ms | 1250.70 µs |
| wit-bindgen | std | 1.648 ms | 1582.62 µs |

初期化は同一プロセス内の新しい ESM 識別子と instance で5回測定した中央値。エンジンのコンパイルキャッシュは消していないため、完全な cold start ではない。HTTP は Request の生成・本文の読み取り・JSON parse・guest 処理・Response の JSON 読み取りを含む。10バッチのウォームアップ、10バッチ×7サンプル。guest 単体と並行16の結果も [JSON](order-middleware-size.json) に保存する。実行速度の CI 閾値は設けない。

## メモリ

| 実装 | Rust | 初期 linear memory | 要求ヒープのピーク | 完了後の要求ヒープ |
|---|---|---:|---:|---:|
| taraba | no_std | 262144 B | 33671 B | 0 B |
| taraba | std | 262144 B | 33671 B | 0 B |
| wit-bindgen | no_std | 131072 B | 1923 B | 0 B |
| wit-bindgen | std | 131072 B | 1923 B | 0 B |

32明細×並行32。サイズ・速度とは別の計装ビルドで、既存 rich-async の同じ counting allocator を使う。要求ヒープは Rust の Layout.size() の合計で、JS ヒープ・allocator metadata・断片化・静的 task pool を含めない。linear memory は pool・stack・予約ページを含む。完了後は timer/immediate を4回進めて測定する。JS の JSON/URL 処理や実際のコピー回数は計測しておらず、プロセス全体のメモリではない。

## 配布・再現・制限

Core の生成 npm に ./http entry を追加し、別アプリへ pack/install して NodeNext / bundler の strict TS と実行を確認する。標準の instantiate → attach は維持する。本文は64 KiBまでの bounded reader で読み、超過時に source を cancel する。WIT に渡す前に untrusted JSON の形と u32 の範囲を検査する。SKU はASCII、customer は UTF-8 80 B以内、明細は128件以内。これらはこの例の業務契約である。

Core と Component の例外・キャンセル契約は同一ではない。全バックエンドの per-call cancel や stream ABI 対応を示すものではない。Safari 向けの動作検証は WebKit E2E で完了。本番 Workers は未検証。

```sh
just compare-order-middleware   # 計測してスナップショットを更新
just check-order-middleware     # 共通テスト・npm/TS・サイズ予算を確認
```
