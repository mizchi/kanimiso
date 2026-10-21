# 小さなランタイムで表現できる範囲を広げる

[English](roadmap.md) | 日本語

目標は、Rust の業務ロジックを安全な型付き async API として、小さな Wasm/JS の npm ライブラリに配布すること。共有 runtime の拡張を最小限にし、機能別のコードは使用時だけ生成する。

| 順番 | 作業 | 完了条件 | 状況 |
|---|---|---|---|
| 1 | 実用ミドルウェアと計測 | URL/JSON を JS、検証・変換を Rust に分担。共通処理・テストで他実装と比較し、npm/TS とサイズ予算を検証 | [注文ミドルウェア](order-middleware.ja.md)を追加 |
| 2 | Core の resource method / Rust-defined exported resource | 状態付き Parser/Validator 等を WIT から公開。own/borrow、再入、キャンセル中の借用、dispose/Drop を検証。未使用時0 B | [Core Future に実装](resources.ja.md)。static method・host import への Rust resource 移譲は対象外 |
| 3 | AsyncIterator / Stream の接続 | pull・backpressure・cancel/return・Drop を契約にする。中断時に上流へ伝播し、未使用時0 B | 未実装。JS の本文 reader と Core stream ABI を区別 |
| 4 | 小さな非同期の合成 API | join/select/timeout、同時実行数制限、描画へ処理を譲る yield。敗者 Future の Drop・I/O の中断・飢餓を検証 | 未実装 |
| 5 | JS 借用 helper | JSON/URL/数値文字列化を、保持・精度・所有権・FFI 回数を定義して追加。使う操作だけ生成 | この例は JS アダプターを使用。汎用 Rust helper は未実装 |
| 6 | 配布先の実アプリ検証 | Vite/Rolldown のアセット配置・Worker・共有 runtime、Safari 向け WebKit・本番 Workers を確認 | Safari 向け WebKit・Module Worker・pack/install・strict TS・Rolldown は完了。本番 Workers などの追加は継続 |

JSPI の複合型は別の計測項目とする。文字列・record・list を executor なしで小さく扱えるかを試し、並行性とキャンセルの契約は Future と分ける。現時点の Core JSPI は scalar profile のまま。

コピー量の実測と JS ヒープを含むメモリ計測も今後の課題。注文例の数値は Rust の要求ヒープと linear memory で、プロセス全体の使用量ではない。型の増加・機能の増加だけを成功条件にせず、実用例の配布サイズ・速度・初期化への影響を一緒に確認する。
