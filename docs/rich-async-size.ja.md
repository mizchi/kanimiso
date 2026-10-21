# 複合型の async 比較

[English](rich-async-size.md) | 日本語

同じ WIT の record・string・list<u8>・result を使い、同じ Rust の [処理](../experiments/rich-async/src/workflow.rs)を実行する。Rust と JS の間を二度 await し、文字列の追記、バイト列の wrapping 演算、ホストでの変換を行う。標準 wit-bindgen との比較は Component の Canonical ABI＋jco、taraba は Core の private Promise ABI である。

計測日: 2026-10-21。Node v24.21.0 / V8 13.6.233.17-node.53、Apple M5。Safari 実機・Wasmtime/WASI の計測ではない。

## 配布サイズ

| 実装 | Rust | Wasm | JS | 合計 |
|---|---|---:|---:|---:|
| taraba | no_std | 4,280 B | 4,449 B | 8,729 B |
| wit-bindgen | no_std | 13,202 B | 83,310 B | 96,512 B |
| taraba | std | 8,415 B | 4,449 B | 12,864 B |
| wit-bindgen | std | 23,727 B | 83,310 B | 107,037 B |

Wasm は wasm-opt -Oz、Rust は LTO・1 codegen unit・panic=abort。両方とも同じ taraba-allocator、default-features=false。JS は Rolldown で一つの ESM に縮小。wit-bindgen 0.58.0 は macros/async のみで async-spawn は無効。jco 1.39.0 が生成した実行用 Core Wasm と JS をすべて含み、Component コンテナや型定義との二重計上は避けた。taraba の JS には共有ランタイムも含む。

## 実行時間

1 呼び出し当たりの中央値。非計装のサイズ計測用ビルドで、30 バッチのウォームアップ後、20 バッチ×7 サンプル。ホスト側は両方とも同じ Promise microtask を待つ。Node は --no-liftoff。並行数16ではバッチ時間を呼び出し数で割った値であり、個々のリクエストのレイテンシではない。

| 実装 | Rust | 32 B / 並行1 | 32 B / 並行16 | 1 KiB / 並行1 | 1 KiB / 並行16 |
|---|---|---:|---:|---:|---:|
| taraba | no_std | 11.87 µs | 7.44 µs | 162.70 µs | 62.22 µs |
| wit-bindgen | no_std | 2591.26 µs | 2453.70 µs | 2940.86 µs | 2765.48 µs |
| taraba | std | 10.69 µs | 6.96 µs | 61.48 µs | 62.03 µs |
| wit-bindgen | std | 2441.38 µs | 2455.37 µs | 2918.15 µs | 2852.20 µs |

このエンジン・バージョン・ワークロードでの観測値。Canonical async のスケジューラと Core の microtask 実行契約の違いも含む。一般的な Rust Future や JSPI の速度差を示すものではない。測定の最小・最大値も JSON に記録する。

## メモリ

同一のカウンタ付きアロケータを載せた別ビルドで測定し、サイズと速度には計装を含めない。次の表は 1 KiB の payload × 並行128を含む一連のバッチ後の値。各バッチ前後に timer/immediate を4回ずつ進める。

| 実装 | Rust | 初期 linear memory | Rust要求ヒープのピーク | 完了後の要求ヒープ | linear memory 到達値 |
|---|---|---:|---:|---:|---:|
| taraba | no_std | 262,144 B | 133,007 B | 0 B | 458,752 B |
| wit-bindgen | no_std | 131,072 B | 305,285 B | 302,806 B | 589,824 B |
| taraba | std | 262,144 B | 133,007 B | 0 B | 458,752 B |
| wit-bindgen | std | 131,072 B | 305,285 B | 302,806 B | 589,824 B |

要求ヒープは Layout.size() の合計で、アロケータのヘッダ・断片化・JS ヒープ・静的タスク領域を含まない。linear memory は静的領域・スタック・予約ページを含む。taraba は 1,024×128 B の静的プールを持つため、初期 linear memory は大きい。これらの値をプロセス全体のメモリ使用量として扱わない。

この wit-bindgen/jco 構成では、Promise 完了とイベントループの待機後も要求ヒープが残った。繰り返し呼び出す独立プローブでも残存量が増え、戻り値は guest memory の view ではなかった。観測した cabi_realloc 呼び出しには new_size=0 の解放がなく、生成 glue の値変換境界の解放処理を調査対象として絞れる。ただし、どの境界の割り当てかは未特定で、標準 Component 全般のリークやメモリ効率を断定する根拠にはしない。バッチ前後の値は JSON に残している。

## 再現と検証

`just compare-rich-async` で JSON と日英の表を更新する。Unicode・空文字・空配列・64 KiB・u32 の wrap・ドメインエラー・入力コピー・並行実行とエラー後の再利用を含む、同じ216ケースを各ビルドで通す。計測用ビルドでも同じテストを通す。

[JSON](rich-async-size.json) · [WIT](../experiments/rich-async/wit/app.wit) · [共通テスト](../experiments/rich-async/contract.mjs) · [計測コード](../tools/compare-rich-async.mjs)
