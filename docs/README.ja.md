# ドキュメント一覧

[English](README.md) | 日本語

## ライブラリを使う

| 知りたいこと | 読むページ |
|---|---|
| どの実行方式・配布形式を選ぶか | [概要と選択表](../README.ja.md) |
| WIT と Rust async を書き、型付き npm ライブラリを作る | [利用ガイド](guide.ja.md) |
| JSPI / Future の所有権・キャンセル・エラーの保証 | [Core API リファレンス](core-runtime.ja.md) |
| Embassy などと同等の処理で、async が何 B 増えるか | [現在の非同期サイズ比較](async-size.ja.md) |
| ビルド・テスト・測定を再実行する | [開発ガイド](development.ja.md) |

利用ガイドは製品のコマンドを説明します。`experiments/` は研究用で、別の公開 API ではありません。Component の Canonical ABI と Core の独自 ABI は区別し、npm はどちらでも選べる配布形式として扱います。

## 測定スナップショットと研究

各結果には測定日時とソースのハッシュを記録しています。現在の scalar サイズ比較は async-size です。過去の結果はその時点の問いに対する値として残し、後の checkout の測定値として流用しません。

| 結果 | 対象 |
|---|---|
| [非同期サイズ](async-size.ja.md) / [JSON](async-size.json) | 同期・非同期の共通処理、taraba / Embassy / Tokio / async-executor / async-std / wasm-bindgen / FuturesUnordered、全配信ファイル |
| [Allocator 最適化](allocator.md) / [JSON](allocator.json) | 変更前後のサイズ・V8 速度・再利用と OOM、wee_alloc 対照 |
| [WIT 比較](wit-comparison.md) | 過去の Core / Component sync・native async、コンパイル・実行時間 |
| [JSPI Future 測定](jspi-future-measurements.md) | 未採用の Future adapter と採用条件 |
| [並行 JSPI](jspi-concurrent.md) | 未採用の stack snapshot、並行性・メモリ・時間 |
| [JSPI 採用方針](jspi-adoption.md) | 既存 Future を残す理由と削除条件 |
| [実行環境の前提](engine-baseline.md) | 対象のエンジン機能と Safari 未検証の範囲 |
| [抽出時の検証](verification.md) / [来歴](../provenance.json) | 過去の切り出し時点の証跡 |

[JSPI Future の実装](../experiments/jspi-future/README.md)と[並行 JSPI の実装](../experiments/jspi-concurrent/README.md)は通常のライブラリビルドには含めません。
