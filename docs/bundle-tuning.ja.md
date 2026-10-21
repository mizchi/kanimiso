# バンドルサイズのチューニング

[English](bundle-tuning.md) | 日本語

同じ作業ツリーの変更前後を比較しました。公開済みバージョンとの比較ではありません。WIT・Rust のアルゴリズム・機能は同じで、両方の通常ビルドと計装ビルドが同じ216ケースを通しています。

内部 codec / interface の wire 名を短縮し、同じ codec 本体を共有します。公開 WIT / Rust / TS の名前は維持します。JS の TextEncoder が作る UTF-8 は Rust 側で再検査せず、生成コードの安全性条件として扱います。Vec のゼロ初期化は維持します。アプリごとの終了処理の重複を減らし、共有 runtime の内部 scope プロパティも短縮しました。

| Rust | Wasm | JS | 合計 | gzip | Brotli |
|---|---:|---:|---:|---:|---:|
| no_std | 5,318 B → 4,280 B | 4,893 B → 4,449 B | 10,211 B → 8,729 B | 5,166 B → 4,652 B | 4,802 B → 4,335 B |
| std | 9,453 B → 8,415 B | 4,893 B → 4,449 B | 14,346 B → 12,864 B | 7,292 B → 6,790 B | 6,693 B → 6,268 B |

JS は Rolldown で共有 runtime も含めて縮小した値です。gzip level 9 / Brotli quality 11 はファイルごとに圧縮した値の合計で、Wasm と JS を連結した値ではありません。Future の共有 runtime 単体は raw と圧縮後のサイズをそれぞれ記録しています。上の複合処理の配布合計では各指標が減っています。

## 共有 JS runtime

| Profile | Raw | gzip | Brotli |
|---|---:|---:|---:|
| release | 3,639 B → 3,585 B | 1,883 B → 1,877 B | 1,716 B → 1,715 B |
| abort | 4,666 B → 4,414 B | 2,224 B → 2,180 B | 2,043 B → 2,003 B |
| jspi | 1,138 B → 1,128 B | 647 B → 646 B | 584 B → 571 B |

`just compare-rich-async` で現在の複合処理を再計測し、`just compare-async-size` / `just compare-core-types` で scalar と型別の表を更新します。変更前後のアセット SHA-256 と数値は [JSON](bundle-tuning.json) に記録しています。ブラウザー E2E、std / no_std、Unicode（孤立サロゲートを含む）、memory.grow、Drop、キャンセル、strict TS を検証対象にしています。

通常版とキャンセル対応版に、Drop 中の dispose が同じタスクを二重に Drop しない回帰テストを追加しました。タスクの実行状態を Drop 完了まで維持する修正も含みます。
