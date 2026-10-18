# WIT / async ABI 比較実験

2026-10-18T12:41:09.239Z

同じ [二段 await](../experiments/wit/shared/compute.rs) を異なるランタイムにコンパイルした。両者で 3,507 件の符号付き i32 計算と全 host I/O、外から解決する二回の待機を共通テストで確認。WIT の型は Core 版が opaque Promise resource、Component 版が async s32。JS オブジェクトの同一性、reject、cancel、fatal の契約は共通ではなく、この比較の同等性の範囲に含めない。

| 構成 | Wasm B | JS B | 合計 B | gzip 合計 B | cold build | V8 μs/task 中央値 | system JSC |
|---|---:|---:|---:|---:|---:|---:|---|
| core-no_std | 1,744 | 3,874 | 5,618 | 2,990 | 7.29 s | 1.137 | 通過 |
| component-no_std | 14,272 | 66,778 | 81,050 | 25,657 | 6.61 s | 2381.402 | JSPI API 不足で失敗 |
| core-std | 7,214 | 3,874 | 11,088 | 5,839 | 7.18 s | 1.145 | 通過 |
| component-std | 25,946 | 66,778 | 92,724 | 30,974 | 7.03 s | 2392.189 | JSPI API 不足で失敗 |

Wasm は配信する全モジュール、JS は loader を含む配信 ESM。Component container と展開後モジュールを二重計上せず、型宣言は除外。圧縮はファイルごとに適用して合計。Component の生成 JS には最終 esbuild minify も適用した。Core の JS は同じ esbuild で生成。両者とも Binaryen 133、Oz / flatten / rereloop / converge、64 KiB stack、1 MiB memory 上限、同じ allocator（size classes 無効）。

ビルドは各構成の空の CARGO_TARGET_DIR 一回、依存ダウンロード済み・offline、Rust と変換工程は別計時。warm build は変更なし三回を JSON に保存。CLI / jco / Binaryen 自体のインストール時間は除外。実行時間は V8 上で 512 同時実行、二段 host await を 4,096 タスクずつ 11 回。ウォームアップ後の中央値で、Rust 計算だけの速度ではない。jco の生成 scheduler は setTimeout（10 ms）で再開する経路を含むため、この差を Wasm 命令自体や Component Model 全体の速度差とは解釈しない。ビルドと性能測定は同時実行しない。

採用: 公開契約は WIT、Rust の型と Guest/imports は公式 wit-bindgen で生成し、既定の実行形式は軽量 Core Wasm とする。WIT のアプリ境界を JS root と externref に lowering し、実行時の Promise scheduler・固定 pool は kanimiso が実装する。標準 Component の Canonical ABI と互換だとは扱わない。Component native async は jco JSPI の実験として残す。system JavaScriptCore では実際の生成物が JSPI API 不足で失敗した。Safari 実ブラウザーの通過は未確認。

再実行: `just compare-wit`。バージョン、各ファイルのサイズ・ハッシュ、各計時サンプル、JSC の実エラー、入力ハッシュは [JSON](wit-comparison.json)。
