# JSPI Future アダプター測定

2026-10-18T15:46:09.036Z / Node v24.21.0 / V8 13.6.233.17-node.53

未採用の実験。同じ二段 await と共通3,507ケース、同じ二回の host I/O・制御された二段待機を全構成で確認。std/no_std、同じ最適化条件。bounded だけは heap allocator を除去する。

| 構成 | Wasm B | JS B | 合計 B | gzip B | μs/task 中央値 |
|---|---:|---:|---:|---:|---:|
| bounded-no_std | 1,842 | 2,700 | 4,542 | 2,277 | 1.363 |
| adapter-no_std | 3,291 | 2,700 | 5,991 | 3,017 | 1.233 |
| jspi-no_std | 248 | 1,324 | 1,572 | 835 | 0.590 |
| core-no_std | 1,744 | 3,874 | 5,618 | 2,989 | 1.228 |
| bounded-std | 1,842 | 2,700 | 4,542 | 2,277 | 1.254 |
| adapter-std | 7,528 | 2,700 | 10,228 | 5,199 | 1.153 |
| jspi-std | 5,623 | 1,324 | 6,947 | 3,628 | 0.546 |
| core-std | 7,214 | 3,874 | 11,088 | 5,838 | 1.232 |

## JS property mangling の比較

同じソースの minify のみ / 内部 property mangling 有効を、同一 Wasm と全共通ケース・probes で比較した。末尾の underscore の private フィールド・補助メソッドだけを一つの bundle 内で短縮する。WIT import、公開 call / promise / stats と診断キー、標準 API は短縮しない。

| 構成 | minify のみ JS B | mangle JS B | 合計 B | gzip B | μs/task 中央値（無効 → 有効） |
|---|---:|---:|---:|---:|---:|
| bounded-no_std | 2919 | 2700 | 4761 → 4542 | 2336 → 2277 | 1.326 → 1.363 |
| adapter-no_std | 2919 | 2700 | 6210 → 5991 | 3076 → 3017 | 1.213 → 1.233 |
| bounded-std | 2919 | 2700 | 4761 → 4542 | 2336 → 2277 | 1.302 → 1.254 |
| adapter-std | 2919 | 2700 | 10447 → 10228 | 5258 → 5199 | 1.211 → 1.153 |

gzip は配信ファイルを個別に圧縮した合計。両 host を各4,096 task 暖機してから、11サンプルを交互順で測る。property 名による速度の優劣は単一測定だけでは断定しない。private 命名を付ける前の JS は2,881 Bで、命名後の無効版は2,919 B。

bounded は ID Waker と stack 上の16件固定登録表を使い、alloc/free が呼ばれると trap する sentinel を置く。std/no_std の Wasm バイトは一致。JF1 は容量超過、JF2 は借用競合の fatal コード。adapter は従来の safe Arc Waker + Vec と JSPI park を使う。jspi は同期 import で直接待機し、core は既存の spawn_local / Rust Future 構成。アプリを含むサイズで、ランタイムの固定費ではない。probe exports は除外し、全配信対象の Wasm と minify 済み JS を計上。

bounded / adapter / direct は同一 instance を直列化する。既存版と cancel / fatal / 並行性の契約は同一ではなく、速度は JS Promise と host 境界を含む。Safari 27 実ブラウザーは未検証。

probe では自己 wake、futures-util の join / select、逆順完了、loser の Drop、古い完了通知、1 KiB Future を32回、reject/trap の first-fatal を確認。bounded は16件の登録・解放と17件目の I/O 開始前の JF1 を検証。動的確保する FuturesUnordered は、同じ固定 driver に allocator を追加した heap-probes で別途通す（最小サイズには含めない）。設計と限界は [実験の説明](../experiments/jspi-future/README.md)、各サンプル・ビルド時間・SHA-256 は [JSON](jspi-future-experiment.json)。
