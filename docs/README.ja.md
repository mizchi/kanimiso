# ドキュメント一覧

[English](README.md) | 日本語

## ライブラリを使う

| 知りたいこと | 読むページ |
|---|---|
| 今できること・未対応・未検証の違いは？ | [現在の対応状況と制限](status.ja.md) |
| WIT → Rust async → TS、interface・resource・終了処理・pool 容量 | [TypeScript との疎通](typescript.ja.md) |
| どの実行方式・配布形式を選ぶか | [概要と選択表](../README.ja.md) |
| WIT と Rust async を書き、型付き npm ライブラリを作る | [利用ガイド](guide.ja.md) |
| pkg/ をそのまま npm に公開する・名前と版を設定する | [生成する npm パッケージ](guide.ja.md#生成する-npm-パッケージ) |
| JSPI / Future の所有権・キャンセル・エラーの保証 | [Core API リファレンス](core-runtime.ja.md) |
| ランタイムのエラーコードを調べる | [エラーコード一覧](error-codes.md) |
| 大きな関数・fmt の保持経路を調べる | [サイズ警告と taraba insight](insight.ja.md) |
| release の panic を簡易レポートにする | [panic hook / handler](panic-reporting.md) |
| RegExp を JS に委ねる・std や依存のサイズを確認する | [taraba-helpers と機能別のサイズ](helpers.ja.md) |
| JS 文字列の正規化・分割・Iterator・文字コード | [文字列と Iterator](strings.ja.md) |
| feature を有効にすると何がバンドルに入るか | [使う関数の選択](strings.ja.md#ビルドに含まれる処理)・[生成 JS と Rolldown のサイズ](strings.ja.md#サイズと検証) |
| 複数ライブラリで JS ランタイムを共有できるか | [ESM キャッシュと共通チャンク](esm-cache.ja.md) |
| Embassy などと同等の処理で、async が何 B 増えるか | [現在の非同期サイズ比較](async-size.ja.md) |
| ビルド・テスト・測定を再実行する | [開発ガイド](development.ja.md) |

利用ガイドは製品のコマンドを説明します。`experiments/` は研究用で、別の公開 API ではありません。Component の Canonical ABI と Core の独自 ABI は区別し、npm はどちらでも選べる配布形式として扱います。

## 測定スナップショットと研究

各結果には測定日時とソースのハッシュを記録しています。現在の scalar サイズ比較は async-size です。過去の結果はその時点の問いに対する値として残し、後の checkout の測定値として流用しません。

| 結果 | 対象 |
|---|---|
| Wasm の内訳と twiggy / wasm-snip の効果 | [セクション内訳と snip の実験](wasm-size-analysis.md) |
| [非同期サイズ](async-size.ja.md) / [JSON](async-size.json) | 同期・非同期の共通処理、taraba / Embassy / Tokio / async-executor / async-std / wasm-bindgen / FuturesUnordered、全配信ファイル |
| [複合型 async](rich-async-size.ja.md) / [JSON](rich-async-size.json) | wit-bindgen と同じ record/string/bytes/Result の処理で、配布サイズ・速度・メモリを比較 |
| [Allocator 最適化](allocator.md) / [JSON](allocator.json) | 変更前後のサイズ・V8 速度・再利用と OOM、wee_alloc 対照 |
| [WIT 比較](wit-comparison.md) | 過去の Core / Component sync・native async、コンパイル・実行時間 |
| [JSPI Future 測定](jspi-future-measurements.md) | 未採用の Future adapter と採用条件 |
| [並行 JSPI](jspi-concurrent.md) | 未採用の stack snapshot、並行性・メモリ・時間 |
| [JSPI 採用方針](jspi-adoption.md) | 既存 Future を残す理由と削除条件 |
| [実行環境の前提](engine-baseline.md) | 対象のエンジン機能と Safari 向け WebKit 検証の方針 |
| [抽出時の検証](verification.md) / [来歴](../provenance.json) | 過去の切り出し時点の証跡 |

[JSPI Future の実装](../experiments/jspi-future/README.md)と[並行 JSPI の実装](../experiments/jspi-concurrent/README.md)は通常のライブラリビルドには含めません。

[バンドルのチューニング前後](bundle-tuning.ja.md)：同じ処理の Wasm / JS / gzip / Brotli。

- [注文ミドルウェアの実用例と計測](order-middleware.ja.md)
- [ロードマップ](roadmap.ja.md)

[WIT から状態付き Rust resource を公開する](resources.ja.md)

[安定版・最新 nightly のブラウザー E2E](browser-testing.ja.md)
