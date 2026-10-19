# 非同期処理のサイズ比較

[English](async-size.md) | 日本語

2026-10-19T01:31:31.075Z

現在の taraba・公式 Embassy WASM executor・wasm-bindgen-futures をビルドし直した。同じ二段 await の Rust ソース、3,507 入力、全 I/O 引数、外から解決する二回の待機を検査した。以下は測定時点のスナップショットであり、固定されたライブラリ overhead や全用途での順位ではない。

## std・同じ allocator で比べる

すべて taraba-allocator の size classes 無効。同じ Rust / Binaryen と、同じ最終 JS minify・Wasm 最適化を使う。Wasm と JS の合計が実行時の配信サイズ。

| 構成 | 同期合計 B | async Wasm B | async JS B | async 合計 B | 同期からの増分 B | Brotli 合計 B |
|---|---:|---:|---:|---:|---:|---:|
| taraba JSPI | 2,149 | 5,307 | 1,431 | 6,738 | +4,589 | 3,206 |
| taraba Future | 4,725 | 6,915 | 4,007 | 10,922 | +6,197 | 5,242 |
| Component + jco | 53,184 | 25,460 | 66,776 | 92,236 | +39,052 | 27,175 |
| wasm-bindgen-futures | 1,861 | 15,303 | 4,442 | 19,745 | +17,884 | 8,358 |
| Embassy WASM + JsFuture | 1,861 | 13,438 | 5,211 | 18,649 | +16,788 | 7,959 |

同じ std / allocator で、Embassy との差は次のとおり。負は taraba 側が小さいことを表す。

| 構成 | async 合計 − Embassy B | 比率 |
|---|---:|---:|
| taraba JSPI | -11,911 | 0.361× |
| taraba Future | -7,727 | 0.586× |
| Component + jco | +73,587 | 4.946× |
| wasm-bindgen-futures | +1,096 | 1.059× |

## no_std の比較

公式 Embassy 0.10.0 の `platform-wasm` は std をリンクするため、この表に no_std 値は作らない。no_std の raw Embassy + 独自ホストという別構成はここでは測っていない。[upstream の cfg](https://docs.rs/crate/embassy-executor/0.10.0/source/src/lib.rs)も参照。std を必要とする構成を no_std と比較して、差を executor だけに帰属させない。

| 構成 | 同期合計 B | async Wasm B | async JS B | async 合計 B | 同期からの増分 B | Brotli 合計 B |
|---|---:|---:|---:|---:|---:|---:|
| taraba JSPI | 1,539 | 248 | 1,431 | 1,679 | +140 | 785 |
| taraba Future | 4,115 | 1,744 | 4,007 | 5,751 | +1,636 | 2,840 |
| Component + jco | 49,226 | 13,789 | 66,776 | 80,565 | +31,339 | 22,680 |
| wasm-bindgen-futures | 1,244 | 9,852 | 4,442 | 14,294 | +13,050 | 6,086 |

### std で増えた Wasm

JS のサイズは同じでも、std のリンクで Wasm が増える。no_std の panic は unreachable、std は標準 panic 経路という構成差も含み、増分全体を task scheduler のサイズとは扱わない。

| 構成 | no_std async Wasm B | std async Wasm B | std − no_std B |
|---|---:|---:|---:|
| taraba JSPI | 248 | 5,307 | +5,059 |
| taraba Future | 1,744 | 6,915 | +5,171 |
| Component + jco | 13,789 | 25,460 | +11,671 |
| wasm-bindgen-futures | 9,852 | 15,303 | +5,451 |

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
| wasm-bindgen-futures | no_std | 14,294 | 14,250 | -44 |
| wasm-bindgen-futures | std | 19,745 | 19,417 | -328 |
| Embassy WASM + JsFuture | std | 18,649 | 18,411 | -238 |

## npm と Component の配布物

実行時サイズには型定義と Component container を足さない。npm tarball はそれらも含む別の配布量で、gzip 圧縮と package metadata の影響も受ける。Component 本体を別 entry として配布すると、展開済み core と container を両方 pack する。

| 構成・モード | 型定義 B | Component B | npm tgz B |
|---|---:|---:|---:|
| taraba JSPI / no_std | 1,340 | 0 | 2,473 |
| taraba JSPI / std | 1,340 | 0 | 5,294 |
| taraba Future / no_std | 2,082 | 0 | 5,033 |
| taraba Future / std | 2,082 | 0 | 7,819 |
| Component + jco / no_std | 2,154 | 14,942 | 28,802 |
| Component + jco / std | 2,154 | 26,614 | 34,342 |
| wasm-bindgen-futures / no_std | 3,419 | 0 | 7,540 |
| wasm-bindgen-futures / std | 3,419 | 0 | 10,193 |
| Embassy WASM + JsFuture / std | 4,457 | 0 | 9,973 |

taraba の実用ガイドは [使い方](guide.ja.md)。Component は WIT から型付き async 戻り値を得られ、Core Future の opaque Promise は unknown のまま。wasm-bindgen の公式生成型も保存しており、この比較の Rust→JS Promise 戻り値には any が含まれる。型情報と API 契約も含めて選ぶ。

## 検証・条件・再実行

Node v24.21.0 / V8 13.6.233.17-node.53; rustc 1.98.0 (88d9e12ae 2026-08-18); Binaryen 133; wasm-bindgen 0.2.129; wasm-bindgen-futures 0.4.79; js-sys 0.3.106; Embassy 0.10.0; jco 1.39.0.

npm pack から展開した全24成果物で同じ3,507ケースと strict TS を通した。async 12成果物では二回の外部制御待機も確認。Core JSPI の直列実行と Future / wasm-bindgen / Embassy の独立タスク進行を別々に検査した。Embassy の開始順は FIFO と仮定していない。Embassy の 1,025 件投入は 1,024 件成功・超過1件だけ reject、その後の pool 再利用も成功した。キャンセル・Drop・fatal・JS オブジェクト同一性が全方式で等しいとの主張はしていない。

計時は行わず、サイズのみ測定。V8 で実行し、Safari 実機・native Component host・JS heap / suspended stack memory は未測定。no_std 行は std feature を無効にし、アプリが panic handler を定義してビルドした。Embassy の公式 WASM platform は std 必須として別扱い。

```sh
just compare-async-size  # rebuild, verify, write this snapshot
just check-async-size    # same verification, .cache output only
```

全ファイルの raw/gzip/Brotli、同期→async の Wasm / JS 別増分、全入力ソースの SHA は [JSON](async-size.json)。過去の抽出前の数値は流用していない。
