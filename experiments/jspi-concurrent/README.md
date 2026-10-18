# 同一インスタンスで JSPI を並行実行する実験

**未採用。製品 CLI の既定は直列 JSPI のまま。** 直接 JSPI と bounded Future アダプターについて、停止中の Rust stack を保護し、独立した root を同一 instance で進める。

```sh
just check-jspi-concurrent       # 既存 Future 実験の検証も含む。測定レポートは更新しない
just experiment-jspi-concurrent  # 検証後、サイズ・即時/遅延時間・Node メモリを測定
just workers --jspi-concurrent   # 上記 build 後。既存構成を含む22通りを local workerd で確認
```

共通アプリは既存と同じ `experiments/wit/shared/compute.rs` の二段 await。WIT / wit-bindgen / CLI の Core lowering を使い、変換後にも Binaryen 133 の同じ最適化をかける。probes の export は最小サイズから分離する。[測定結果](../../docs/jspi-concurrent.md)、[採用条件](../../docs/jspi-adoption.md)を参照。

## スタックの切り替え

JSPI が保持する native Wasm stack と、LLVM が線形メモリに置く spill stack は別物。`__stack_pointer` だけを戻しても、先に終了した別の root の epilogue によって、停止中の root の領域が上書きされる。

この実験は、同じアドレスの stack 領域を各 root で再利用する。実際に使用した `[sp, __stack_high)` だけを JS の Uint8Array に保存する。heap / static data は保存・復元しない。新しい root は常に `__stack_high` から始める。

`src/bin/transform.rs` が Wasm の import / export にトランポリンを付ける。元の import FunctionId を保つため、直接 call だけでなく同じ関数への参照も shim を通る。root の識別子は externref として native Wasm の local に残す。線形メモリ上の stack には置かない。

private Core ABI は次の通り。アプリの WIT / Component Canonical ABI ではない。

| hook | 型 | 遷移 |
|---|---|---|
| enter | `() -> externref` | root を作り、running にする |
| suspend | `(externref, i32) -> ()` | 使用中の stack を保存し、SP を high に戻す。parked になる |
| resume | `(externref) -> i32` | 同期的に stack のバイトを復元し、SP を返す。running に戻る |
| leave | `(externref) -> ()` | 正常終了した root を除去する |

import の shim は、停止前の context を native local に保存し、**JSPI が Wasm を再開した後**に同期 `resume` を呼ぶ。続けて SP と現在の context を設定し、Rust へ戻る。この間に Promise reaction が入る隙間を作らない。Promise の完了 callback 側では stack を復元しない。

`stack.mjs` は状態と snapshot を管理する。`host.mjs` は scalar import と Promise / fatal を接続する。Future アダプターは同じ stack 管理を `park` の前後に適用する。open / begin / drain / Waker 通知などの管理用 import は同期のまま。

`bundleHost({concurrent:true})` で実験 Future host の並行版を作る。既定 false では stack 管理コードを除去し、従来の直列版を維持する。`__JSC_DEBUG__` / `__JF_DEBUG__` が false の release は snapshot 統計を含まない。debug の統計を性能・配信サイズへ混ぜない。

## 契約と検証

- 単一 JS agent、非共有 wasm32 memory、scalar i32/f64 境界のみ。start function、imported memory、reference 引数などは拒否する。明示的な stack bounds と変換済み marker が必要。未変換モジュールを並行 host へ渡さない。
- すべての suspend 経路を shim に通す。直接版は全 app import、Future 版は `park` を対象とする。復元時に SP が high でなければ、未保護の stack があると判断して復元前に停止する。
- 生の instance exports、guest memory、Rust stack を指す整数などをホストへ公開しない。この実験は任意の Rust ポインターや借用を JS へ渡す ABI の安全性を提供しない。
- 共有状態は共有のまま。std の RefCell guard を保持している root に対して、別の root は try_borrow に失敗する。no_std probe は AtomicBool の guard で競合を表す。アプリのロック・TLS・再入の設計は別途必要。
- 正常完了の Rust Drop は実行する。reject / trap は first-fatal として全 root を閉じ、snapshot と待機登録を除去する。まだ終了しない sibling I/O があっても、その root の Promise を reject する。Rust unwind / Drop の強制実行や元の I/O の abort は保証しない。**root cancel は未実装。**

実 Wasm の probes は、512 B の配列を持つ A / B、A の完了後に4 KiBを使用する C、最後に B を再開する順序で spill を確認する。同じ Rust の未保護版では B の破損を trap として検出する。さらに32 root の非 LIFO / 同時完了、memory.grow、共有 static data の更新を巻き戻さないこと、instance 間の分離、共有借用の競合、binding の同一 instance 再入、reject / trap 後の古い完了通知を確認する。

Future 版は32個の1 KiB Future、子 Waker、self wake、join/select、loser Drop、固定表容量も確認する。allocator を有効にした別の heap-probes では FuturesUnordered を含む16 root / 32 child I/O の逆順完了を検証する。heap-probes の Wasm は最小サイズへ加算しない。

## 測定の範囲

即時 Promise は既存 Future と交互順で11サンプル、各4,096 task。遅延は同じ二段の5 ms timer を使う16件の batch。ビルド・検証・他の負荷試験と性能測定を同時実行しない。

`parked_spills` は debug host の JS snapshot だけを数える。512 B の配列や1 KiB Future と、保存する frame 全体の大きさは異なる。

`process_memory` は構成・投入数ごとに独立した Node `--expose-gc` を3回起動する。64 task 暖機後、128 / 1,024件を投入し、最初の I/O を未解決に保った状態の RSS / JS heap / ArrayBuffer の増分を記録する。直列構成では1件の I/O と残りの待ち行列、並行構成では投入数ぶんの I/O が停止していることも数える。RSS は JIT・engine のページなどを含む粗い値であり、task ごとの厳密な stack サイズではない。全サンプルと完了後の値を JSON に残す。

Node V8 と local workerd を対象に検証する。Safari 27 実ブラウザーは未検証。Miri / Kani は既存 Rust 部品の限定された native 検証であり、この JS snapshot 実装・Wasm 変換・エンジン全体の形式証明ではない。

エラーコード: JC1 は stack 契約・handoff の不一致、JC2 は範囲不正、JC3 は root の状態不正、JC4 は binding / export 不正、JC6 は JSPI 未対応。ホスト由来の reject / trap は元の理由を保持する。

参考: [Pyodide: Integrating JSPI with the WebAssembly C Runtime](https://blog.pyodide.org/posts/jspi-with-c-runtime/)、[guybedford/jspi](https://github.com/guybedford/jspi)。後者は Emscripten 向けの別実装。この実験へコードや依存は取り込んでいない。
