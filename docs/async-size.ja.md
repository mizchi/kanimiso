# 非同期処理のサイズ比較

[English](async-size.md) | 日本語

2026-10-19T04:15:20.692Z

taraba・Embassy・wasm-bindgen-futures・Tokio・async-executor・async-std・FuturesUnordered をビルドし直した。同じ二段 await の Rust ソース、3,507 入力、全 I/O 引数、外から解決する二回の待機を検査した。以下は測定時点のスナップショットであり、固定されたライブラリ overhead や全用途での順位ではない。

## std・同じ allocator で比べる

すべて taraba-allocator の size classes 無効。同じ Rust / Binaryen と、同じ最終 JS minify・Wasm 最適化を使う。Wasm と JS の合計が実行時の配信サイズ。

| 構成 | 同期合計 B | async Wasm B | async JS B | async 合計 B | 同期からの増分 B | Brotli 合計 B |
|---|---:|---:|---:|---:|---:|---:|
| taraba JSPI | 2,120 | 5,263 | 1,402 | 6,665 | +4,545 | 3,165 |
| taraba Future | 4,725 | 6,871 | 4,007 | 10,878 | +6,153 | 5,219 |
| Embassy WASM + JsFuture | 1,861 | 13,360 | 5,211 | 18,571 | +16,710 | 7,950 |
| wasm-bindgen-futures | 1,861 | 15,221 | 4,442 | 19,663 | +17,802 | 8,334 |
| Tokio current-thread + LocalSet | 1,861 | 52,721 | 4,442 | 57,163 | +55,302 | 22,384 |
| async-executor LocalExecutor | 1,861 | 32,324 | 4,442 | 36,766 | +34,905 | 15,196 |
| async-std spawn_local | 1,861 | 17,930 | 4,442 | 22,372 | +20,511 | 9,245 |
| FuturesUnordered task set | 1,861 | 18,495 | 4,440 | 22,935 | +21,074 | 9,589 |
| Component + jco | 53,140 | 25,350 | 66,776 | 92,126 | +38,986 | 27,091 |

同じ std / allocator で、Embassy との差は次のとおり。負は taraba 側が小さいことを表す。

| 構成 | async 合計 − Embassy B | 比率 |
|---|---:|---:|
| taraba JSPI | -11,906 | 0.359× |
| taraba Future | -7,693 | 0.586× |
| wasm-bindgen-futures | +1,092 | 1.059× |
| Tokio current-thread + LocalSet | +38,592 | 3.078× |
| async-executor LocalExecutor | +18,195 | 1.980× |
| async-std spawn_local | +3,801 | 1.205× |
| FuturesUnordered task set | +4,364 | 1.235× |
| Component + jco | +73,555 | 4.961× |

## 追加ランタイムと共有基盤からの増分

追加構成は wasm-bindgen-futures の JsFuture と future_to_promise を共有し、そこに各 scheduler を載せる。次の差は同じ std/no_std・allocator の wasm-bindgen-futures 行との差で、接続コードと task/JoinHandle も含む。ライブラリ単体の固定費ではない。

| 構成 | mode | 追加 Wasm B | 追加 JS B | 追加合計 B |
|---|---|---:|---:|---:|
| Tokio current-thread + LocalSet | std | +37,500 | 0 | +37,500 |
| async-executor LocalExecutor | std | +17,103 | 0 | +17,103 |
| async-std spawn_local | std | +2,709 | 0 | +2,709 |
| FuturesUnordered task set | no_std | +2,300 | 0 | +2,300 |
| FuturesUnordered task set | std | +3,274 | -2 | +3,272 |

- **Tokio**: `rt` のみ。instance ごとに current-thread Runtime と LocalSet を一つ持ち、compute を spawn_local して JoinHandle を待つ。独自の JS 接続が、各 wake で直ちに Ready を返す root の block_on 内から LocalSet を一度 poll する。JS スレッドを park せず、次の JS wake で再開する。接続コードも計上し、timer/net/multithread は含めない。[Tokio の WASM 制約](https://docs.rs/tokio/latest/tokio/#wasm-support)、[LocalSet](https://docs.rs/tokio/latest/tokio/task/struct.LocalSet.html)。
- **async-executor**: instance ごとに LocalExecutor を一つ持ち、永続する wasm-bindgen の driver が run(pending) を駆動する。spawn した compute の Task を待つ。smol の I/O reactor 全体を測る構成ではない。[LocalExecutor](https://docs.rs/async-executor/latest/async_executor/struct.LocalExecutor.html)。
- **async-std**: default features と unstable の spawn_local を使用。Wasm 実装は wasm-bindgen-futures と channel の JoinHandle を使う。[API](https://docs.rs/async-std/latest/async_std/task/fn.spawn_local.html)。[開発終了済み](https://github.com/async-rs/async-std)のため、既存コードとの比較用に含めた。
- **FuturesUnordered**: 1呼び出しにつき compute 一件を入れ、StreamExt::next を待つ。単独の runtime や spawn API を持たないタスク集合の参考値であり、常駐する executor と同じ機能ではない。[API](https://docs.rs/futures-util/latest/futures_util/stream/struct.FuturesUnordered.html)。

## no_std の比較

Embassy の公式 platform-wasm、Tokio、async-executor、async-std の今回の構成は std をリンクするため、no_std 値は作らない。no_std の raw Embassy + 独自ホストという別構成はここでは測っていない。[Embassy の cfg](https://docs.rs/crate/embassy-executor/0.10.0/source/src/lib.rs)も参照。FuturesUnordered は alloc を使うタスク集合として no_std も測る。

| 構成 | 同期合計 B | async Wasm B | async JS B | async 合計 B | 同期からの増分 B | Brotli 合計 B |
|---|---:|---:|---:|---:|---:|---:|
| taraba JSPI | 1,510 | 248 | 1,402 | 1,650 | +140 | 773 |
| taraba Future | 4,115 | 1,744 | 4,007 | 5,751 | +1,636 | 2,840 |
| wasm-bindgen-futures | 1,244 | 9,783 | 4,442 | 14,225 | +12,981 | 6,057 |
| FuturesUnordered task set | 1,244 | 12,083 | 4,442 | 16,525 | +15,281 | 7,082 |
| Component + jco | 49,182 | 13,691 | 66,776 | 80,467 | +31,285 | 22,625 |

### std で増えた Wasm

この表は std のリンクによる Wasm の増分を示す。JS の変化は実行時合計に別途計上する。no_std の panic は unreachable、std は標準 panic 経路という構成差も含み、増分全体を task scheduler のサイズとは扱わない。

| 構成 | no_std async Wasm B | std async Wasm B | std − no_std B |
|---|---:|---:|---:|
| taraba JSPI | 248 | 5,263 | +5,015 |
| taraba Future | 1,744 | 6,871 | +5,127 |
| wasm-bindgen-futures | 9,783 | 15,221 | +5,438 |
| FuturesUnordered task set | 12,083 | 18,495 | +6,412 |
| Component + jco | 13,691 | 25,350 | +11,659 |

## 増分の読み方

同期版も `add(a,b)` → `add(first,1)` を同じ順で実行する。それぞれのバックエンドの公開 JS API を含むので、すでにリンクした固定費は同期側にも計上される。素の WebAssembly に全 async 機能を追加したコストとは異なる。

- JSPI は同期版・async 版とも同じ Promise host を使う。Rust Future は host import 内で suspend し、poll は Ready を返す。測定では JS のサイズは同じでも、同期の関数と Rust Future のコード生成差が Wasm に残った。エンジンの JSPI 実装や suspended stack memory は配信サイズに含まれない。
- taraba Future の同期版にも既存ホスト全体を含む。async の増分とホストの固定費は別。
- Component は typed WIT async / Canonical ABI と jco scheduler を含む。この scalar workload は record 等の汎用性を使っていない。
- Embassy は公式の WASM event-loop integration、JsFuture、型付き worker ×1,024 を使う。固定 pool の予約メモリと配信 Wasm bytes は別で、任意サイズの Future を動的 spawn する API と同じ契約ではない。

## allocator を揃えた理由・wee_alloc 対照

次の表だけ allocator を wee_alloc 0.4.5 に変更し、size classes はどちらも無効にした。差は allocator とその呼び出し元の最適化を含み、executor の変更ではない。

| 構成 | モード | taraba-allocator 合計 B | wee_alloc 合計 B | wee − taraba B |
|---|---|---:|---:|---:|
| wasm-bindgen-futures | no_std | 14,225 | 14,250 | +25 |
| wasm-bindgen-futures | std | 19,663 | 19,417 | -246 |
| Embassy WASM + JsFuture | std | 18,571 | 18,411 | -160 |

## npm と Component の配布物

実行時サイズには型定義と Component container を足さない。npm tarball はそれらも含む別の配布量で、gzip 圧縮と package metadata の影響も受ける。Component 本体を別 entry として配布すると、展開済み core と container を両方 pack する。

| 構成・モード | 型定義 B | Component B | npm tgz B |
|---|---:|---:|---:|
| taraba JSPI / no_std | 1,340 | 0 | 2,462 |
| taraba JSPI / std | 1,340 | 0 | 5,271 |
| taraba Future / no_std | 2,082 | 0 | 5,033 |
| taraba Future / std | 2,082 | 0 | 7,813 |
| Embassy WASM + JsFuture / std | 4,457 | 0 | 9,946 |
| wasm-bindgen-futures / no_std | 3,419 | 0 | 7,506 |
| wasm-bindgen-futures / std | 3,419 | 0 | 10,156 |
| Tokio current-thread + LocalSet / std | 3,419 | 0 | 26,616 |
| async-executor LocalExecutor / std | 3,419 | 0 | 18,215 |
| async-std spawn_local / std | 3,419 | 0 | 11,205 |
| FuturesUnordered task set / no_std | 3,419 | 0 | 8,632 |
| FuturesUnordered task set / std | 3,415 | 0 | 11,585 |
| Component + jco / no_std | 2,154 | 14,844 | 28,744 |
| Component + jco / std | 2,154 | 26,504 | 34,298 |

taraba の実用ガイドは [使い方](guide.ja.md)。Component は WIT から型付き async 戻り値を得られ、Core Future の opaque Promise は unknown のまま。wasm-bindgen の公式生成型も保存しており、この比較の Rust→JS Promise 戻り値には any が含まれる。型情報と API 契約も含めて選ぶ。

## 検証・条件・再実行

Node v24.21.0 / V8 13.6.233.17-node.53; rustc 1.98.0 (88d9e12ae 2026-08-18); Binaryen 133; wasm-bindgen 0.2.129; wasm-bindgen-futures 0.4.79; js-sys 0.3.106; Embassy 0.10.0; Tokio 1.53.3; async-executor 1.14.0; async-std 1.13.2; futures-util 0.3.34; jco 1.39.0.

npm pack から展開した全34成果物で同じ3,507ケースと strict TS を通した。async 17成果物では二回の外部制御待機も確認。Core JSPI の直列実行とその他の独立タスク進行を別々に検査した。追加ランタイムと Embassy の開始順は FIFO と仮定していない。Embassy の 1,025 件投入は 1,024 件成功・超過1件だけ reject、その後の pool 再利用も成功した。キャンセル・Drop・fatal・JS オブジェクト同一性が全方式で等しいとの主張はしていない。

wasm-bindgen 系の async 11成果物では、一回目・二回目それぞれの await の Promise 拒否、拒否オブジェクトの同一性、並行する別タスクの成功、その後の再利用も検査した。JSPI / Core Future / Component のエラー契約とは分けている。

計時は行わず、サイズのみ測定。V8 で実行し、Safari 実機・native Component host・JS heap / suspended stack memory は未測定。no_std 行は std feature を無効にし、アプリが panic handler を定義してビルドした。Embassy の公式 WASM platform は std 必須として別扱い。

```sh
just compare-async-size  # rebuild, verify, write this snapshot
just check-async-size    # same verification, .cache output only
```

全ファイルの raw/gzip/Brotli、同期→async の Wasm / JS 別増分、全入力ソースの SHA は [JSON](async-size.json)。過去の抽出前の数値は流用していない。
