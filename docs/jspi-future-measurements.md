# JSPI Future アダプター測定

2026-10-18T14:40:06.203Z / Node v24.21.0 / V8 13.6.233.17-node.53

未採用の実験。同じ二段 await と共通3,507ケース、同じ二回の host I/O・制御された二段待機を全構成で確認。std/no_std、同じ allocator と最適化条件。

| 構成 | Wasm B | JS B | 合計 B | gzip B | μs/task 中央値 |
|---|---:|---:|---:|---:|---:|
| adapter-no_std | 3,291 | 2,848 | 6,139 | 3,054 | 1.274 |
| jspi-no_std | 248 | 1,324 | 1,572 | 835 | 0.749 |
| core-no_std | 1,744 | 3,874 | 5,618 | 2,989 | 1.251 |
| adapter-std | 7,528 | 2,848 | 10,376 | 5,234 | 1.265 |
| jspi-std | 5,623 | 1,324 | 6,947 | 3,628 | 0.679 |
| core-std | 7,214 | 3,874 | 11,088 | 5,838 | 1.230 |

adapter は Future をスタックに保持し、safe Arc Waker と JSPI park で駆動する。jspi は同期 import で直接待機し、core は既存の spawn_local / Rust Future 構成。アプリを含むサイズで、ランタイムの固定費ではない。probe exports は除外し、全配信対象の Wasm と minify 済み JS を計上。

adapter/direct は同一 instance を直列化する。既存版と cancel / fatal / 並行性の契約は同一ではなく、速度は JS Promise と host 境界を含む。Safari 27 実ブラウザーは未検証。

probe では自己 wake、futures-util の join / select、逆順完了、loser の Drop、古い完了通知、1 KiB Future を32回、reject の first-fatal を確認。設計と限界は [実験の説明](../experiments/jspi-future/README.md)、各サンプル・ビルド時間・SHA-256 は [JSON](jspi-future-experiment.json)。
