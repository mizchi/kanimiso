# JSPI 同一インスタンス並行実行の実験

2026-10-18T18:05:24.663Z / Node v24.21.0 / V8 13.6.233.17-node.53 / Apple M5

未採用。製品の既定は引き続き直列 JSPI。全構成で同じ二段 await と3,507ケース、同じ二回の host I/O、各 scheduling 契約を確認した。

| 構成 | Wasm B | JS B | 合計 B | 即時 μs/task | 16 tasks・各二段5ms待ちの batch ms |
|---|---:|---:|---:|---:|---:|
| jspi-serial-no_std | 248 | 1324 | 1572 | 0.636 | 181.30 |
| core-future-no_std | 1744 | 3874 | 5618 | paired reference | 11.75 |
| bounded-serial-no_std | 1842 | 2394 | 4236 | 1.086 | 180.64 |
| jspi-concurrent-no_std | 499 | 2257 | 2756 | 4.152 | 11.82 |
| bounded-concurrent-no_std | 2091 | 3474 | 5565 | 4.980 | 12.38 |
| jspi-serial-std | 5619 | 1324 | 6943 | 0.575 | 180.79 |
| core-future-std | 7210 | 3874 | 11084 | paired reference | 11.87 |
| bounded-serial-std | 1842 | 2394 | 4236 | 1.062 | 182.77 |
| jspi-concurrent-std | 5870 | 2257 | 8127 | 4.137 | 11.47 |
| bounded-concurrent-std | 2091 | 3474 | 5565 | 5.163 | 11.62 |

即時は一度に512件を投入し、各行は既存 Future と交互に測定した別のペア。直列構成はキューで順に実行し、並行構成は各 root が同時に停止しうる。対応する既存 Future の値・全サンプルは [JSON](jspi-concurrent.json) を参照。遅延は実ネットワークではなく同じ5msタイマー二段、同じ16件。ビルド・検証は計測前に完了し、同時に走らせない。

サイズは共通アプリを含む配信 Wasm＋release JS。probes の export は含めない。並行版に必要な stack bounds の export とトランポリンも含む。Rust std/no_std、Binaryen 133 の同じ最適化条件。非同期の契約や対応する型は同一ではない。

Rust の実512 B spill、4 KiB上書き、非 LIFO・同時完了・memory.grow・共有借用競合・binding 再入・最初の fatal と未完了 sibling の解放を確認。保護なしの同じ Rust では victim の stack 破損を検出した。Future アダプターでも32個の1 KiB Future、join/select・子 Waker・Drop と late completion を確認する。別の allocator 有効 probe では FuturesUnordered を含む16 root / 32 child I/O の逆順完了も確認する。その probe のサイズは最小構成に含めない。debug は snapshot の統計を含み、release は含めない。

## 停止中のプロセスメモリ

Node --expose-gc の独立プロセスを構成ごとに3回。64 task 暖機し、1,024件を投入して最初の I/O を止め、GC 後の増分の中央値を記録した。128件と全サンプル・前後の値は JSON に保存。

| 構成 | 実際に停止中の I/O | 追加 RSS KiB | 追加 JS heap KiB | 追加 ArrayBuffer KiB |
|---|---:|---:|---:|---:|
| jspi-serial-no_std | 1 | 400 | 768 | 0 |
| core-future-no_std | 1024 | 5008 | 1066 | 0 |
| bounded-serial-no_std | 1 | 528 | 448 | 0 |
| jspi-concurrent-no_std | 1024 | 20496 | 2351 | 0 |
| bounded-concurrent-no_std | 1024 | 21200 | 2854 | 432 |
| jspi-serial-std | 1 | 400 | 768 | 0 |
| core-future-std | 1024 | 5008 | 1065 | 0 |
| bounded-serial-std | 1 | 464 | 448 | 0 |
| jspi-concurrent-std | 1024 | 20432 | 2351 | 0 |
| bounded-concurrent-std | 1024 | 21200 | 2854 | 432 |

直列構成は1件の I/O と1,023件の待ち行列、並行構成は1,024件の I/O。RSS は engine / JIT / allocator のページを含む粗いプロセス増分であり、task の厳密な stack サイズではない。JSON の parked_spills は別の32 task / 512 Bまたは1 KiB Rust配列 probe での JS snapshot のみで、engine stack や他の JS heap を含めない。snapshot のコピーコストは保持する Rust stack の深さに依存する。Safari 向け検証は[WebKit E2E の方針](browser-testing.ja.md)に従う。root cancel / Rust Drop の強制実行は未実装。製品への採用条件は [採用方針](jspi-adoption.md)、再実行は `just experiment-jspi-concurrent`。
