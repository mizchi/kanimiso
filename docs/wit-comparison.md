# WIT / JSPI 比較実験

2026-10-18T16:41:28.064Z

この表は測定時点のスナップショット。現在の CLI は JSPI が既定、従来 Future は `--future`。移行と削除条件は [採用方針](jspi-adoption.md)を参照。

実験環境の前提は **Safari 27+ / JSPI 対応 V8**。[WebKit 公式](https://webkit.org/blog/18325/webkit-features-for-safari-27-0/#webassembly)で Safari 27 の JSPI 対応を確認した。旧 system JSC の未対応を最新 Safari の非対応とは扱わない。Safari 27 実ブラウザーはこの測定では未検証。

同じ [二段 await](../experiments/wit/shared/compute.rs) をコンパイルし、全構成で符号付き i32 の共通 3,507 ケース、全 host I/O、外から解決する二回の待機を通した。JSPI の Rust デモは同期 import 内でエンジンが待機し、同じ Future の poll は Ready を返す。任意の Pending Future の executor ではない。

| 構成 | Wasm B | JS B | 合計 B | gzip 合計 B | cold build | V8 μs/task 中央値 | system JSC |
|---|---:|---:|---:|---:|---:|---:|---|
| jspi-no_std | 248 | 1,324 | 1,572 | 835 | 6.60 s | 0.725 | 旧 JSC: 前提外 |
| core-no_std | 1,744 | 3,874 | 5,618 | 2,989 | 7.20 s | 1.157 | 通過 |
| component-sync-no_std | 1,795 | 48,725 | 50,520 | 14,856 | 6.16 s | 15.869 | 旧 JSC: 前提外 |
| component-no_std | 14,272 | 66,778 | 81,050 | 25,657 | 6.84 s | 2384.283 | 旧 JSC: 前提外 |
| jspi-std | 5,619 | 1,324 | 6,943 | 3,632 | 6.48 s | 1.436 | 旧 JSC: 前提外 |
| core-std | 7,210 | 3,874 | 11,084 | 5,830 | 6.98 s | 2.041 | 通過 |
| component-sync-std | 5,841 | 48,725 | 54,566 | 16,990 | 6.65 s | 15.780 | 旧 JSC: 前提外 |
| component-std | 25,942 | 66,778 | 92,720 | 30,967 | 6.88 s | 2384.538 | 旧 JSC: 前提外 |

jspi は直接 Core JSPI、core は従来の Future 構成、component-sync は同期 WIT + jco JSPI、component は WIT native async + jco JSPI。サイズは実際に配信する全 Wasm と loader を含む JS の合計。Component container を展開後ファイルと二重計上せず、型宣言は除外。圧縮はファイルごとに適用。

全構成で Binaryen 133、Oz / flatten / rereloop / converge、64 KiB stack、1 MiB memory 上限、同じ allocator（size classes 無効）。JS は esbuild minify を適用。直接 JSPI は Rust task pool を持たず、不要な canonical realloc とメタデータを除去する。Rust/JS ともアプリを含むサイズであり、機能が同一なランタイムの固定費ではない。

ビルドは各構成の空の CARGO_TARGET_DIR 一回、依存取得後・offline。Rust build と変換工程は別計時で、warm build 三回も JSON に保存する。ツールのインストール時間は除外。実行は V8 上で 512 呼び出しを投入し、4,096 タスクずつ 11 回。直接 JSPI は投入された呼び出しを instance 内で直列実行する。ビルドと性能測定は同時実行しない。

速度は JSPI / Promise / host I/O / scheduler 込み。WIT native async の jco scheduler は setTimeout（10 ms）を使う経路を含むため、値を Wasm 命令自体や Component Model 全体の速度差とは解釈しない。

採用方針: JSPI を実行環境の前提として、スカラー I/O は省サイズの **--jspi** を用意する。これは guest entry の直列化と reject / trap 時の first-fatal を契約とする。spawn_local / cancel / 一般的な Rust Future を使う場合は従来構成を選ぶ。JS オブジェクト同一性、reject、cancel、fatal の契約の同等性は共通計算テストの範囲に含めない。Core lowering は Component Model Canonical ABI とは異なる。

実製品の JSPI 検証は `just check` と `just package-check`。release/debug × std/no_std で同じ入力と実 Rust stack spill、crate 外の consumer を確認する。測定再実行は `just compare-wit`。バージョン、全サンプル、各ファイルと入力のハッシュは [JSON](wit-comparison.json)。
