# Allocator のサイズ・速度検証

2026-10-19T03:11:42.689Z

Node v24.21.0 / V8 13.6.233.17-node.53 (--no-liftoff); rustc 1.98.0 (88d9e12ae 2026-08-18); Binaryen 133。変更前は 8cb75b788a4720753ac6fd30f64615f575e8761e。

同じ9種類の Rust kernel と allocator oracle を使い、同じ wasm-opt 設定で比較する。Wasm は probe・検証・計算コードを含み、allocator 単体の固定費ではない。全体の oracle に失敗した wee_alloc は同等性を満たす比較対象から除外する。以下の時間は同じ検査を通った変更前後だけを測り、wee_alloc が高速かどうかの順位は付けない。

| 構成 | mode | classes | Wasm B | 全体 oracle |
|---|---|---|---:|---|
| before | no_std | off | 3212 | pass |
| before | no_std | on | 3695 | pass |
| before | std | off | 10147 | pass |
| before | std | on | 10637 | pass |
| current | no_std | off | 3139 | pass |
| current | no_std | on | 3677 | pass |
| current | std | off | 10053 | pass |
| current | std | on | 10593 | pass |
| inplace | no_std | off | 3163 | pass |
| inplace | no_std | on | 3701 | pass |
| inplace | std | off | 10077 | pass |
| inplace | std | on | 10617 | pass |
| wee | no_std | off | 3185 | 隣接領域の再利用で失敗 |
| wee | no_std | on | 3739 | 隣接領域の再利用で失敗 |
| wee | std | off | 9878 | 隣接領域の再利用で失敗 |
| wee | std | on | 10423 | 隣接領域の再利用で失敗 |

current は GlobalAlloc の非ゼロサイズ・有効な Layout・生存中ポインタという契約を使い、サイズ0・align 0・null 解放の分岐を除去した。raw ABI 側では引き続きサイズ0等を拒否してから呼び出す。[Rust の契約](https://doc.rust-lang.org/stable/core/alloc/trait.GlobalAlloc.html)も参照。

inplace は current に任意 feature `realloc_in_place` を加えた構成。wasm32 の4 B単位の丸め結果が変わらない realloc でポインタを保ち、その他は allocate/copy/free に戻る。クラス変更時の誤った free list への解放を避け、既定では無効。realloc_same_word は25→28→25 Bを繰り返す専用ケースで、一般的な Vec の倍増を代表しない。

最適化済み Wasm（--no-liftoff）に固定し、kernel/instance ごとに50 ms以上ウォームアップ。21回の測定順を循環させた中央値 ns/job。JIT・instance 生成は除外し、各 sample で結果と memory plateau を確認する。数%の差や今回1回の測定だけで速度の優劣を断定しない。JS→Wasm 呼び出しを含む V8 上の結果で、Criterion/Wasmtime の過去結果とは混ぜない。

| mode / classes / kernel | 変更前 | 現在 | inplace | wee_alloc（除外） |
|---|---:|---:|---:|---:|
| no_std / off / boundary | 8.3 | 8.3 | 8.3 | excluded |
| no_std / off / pair_32 | 6.4 | 6.4 | 6.5 | excluded |
| no_std / off / pair_1024 | 6.4 | 6.7 | 6.3 | excluded |
| no_std / off / aligned_4096 | 6.7 | 6.7 | 6.8 | excluded |
| no_std / off / burst_fifo | 12.2 | 10.9 | 11.2 | excluded |
| no_std / off / burst_lifo | 11.7 | 11.0 | 10.9 | excluded |
| no_std / off / grow_realloc | 24.1 | 23.0 | 23.8 | excluded |
| no_std / off / coalesce | 11.1 | 11.6 | 11.6 | excluded |
| no_std / off / realloc_same_word | 27.7 | 29.2 | 12.7 | excluded |
| no_std / on / boundary | 8.4 | 8.4 | 8.3 | excluded |
| no_std / on / pair_32 | 8.8 | 8.6 | 9.0 | excluded |
| no_std / on / pair_1024 | 9.1 | 8.8 | 8.8 | excluded |
| no_std / on / aligned_4096 | 9.6 | 9.0 | 9.2 | excluded |
| no_std / on / burst_fifo | 19.9 | 18.1 | 18.2 | excluded |
| no_std / on / burst_lifo | 19.6 | 17.6 | 17.7 | excluded |
| no_std / on / grow_realloc | 40.6 | 40.9 | 39.6 | excluded |
| no_std / on / coalesce | 18.6 | 18.7 | 18.7 | excluded |
| no_std / on / realloc_same_word | 43.5 | 43.9 | 19.8 | excluded |
| std / off / boundary | 8.3 | 8.2 | 8.4 | excluded |
| std / off / pair_32 | 10.5 | 10.9 | 10.3 | excluded |
| std / off / pair_1024 | 10.4 | 10.3 | 10.3 | excluded |
| std / off / aligned_4096 | 10.9 | 11.2 | 10.7 | excluded |
| std / off / burst_fifo | 15.8 | 15.4 | 15.1 | excluded |
| std / off / burst_lifo | 15.8 | 14.5 | 15.4 | excluded |
| std / off / grow_realloc | 30.6 | 30.4 | 29.8 | excluded |
| std / off / coalesce | 13.6 | 13.1 | 12.3 | excluded |
| std / off / realloc_same_word | 31.5 | 34.2 | 16.1 | excluded |
| std / on / boundary | 8.3 | 8.4 | 8.3 | excluded |
| std / on / pair_32 | 14.3 | 14.1 | 14.1 | excluded |
| std / on / pair_1024 | 16.4 | 16.5 | 15.7 | excluded |
| std / on / aligned_4096 | 16.8 | 16.9 | 16.4 | excluded |
| std / on / burst_fifo | 21.1 | 21.2 | 20.7 | excluded |
| std / on / burst_lifo | 20.7 | 20.4 | 20.2 | excluded |
| std / on / grow_realloc | 40.7 | 39.8 | 42.4 | excluded |
| std / on / coalesce | 19.3 | 18.7 | 18.9 | excluded |
| std / on / realloc_same_word | 45.5 | 44.3 | 19.2 | excluded |

全 sample、入力 SHA、Wasm SHA、再利用・OOM・realloc の結果は [JSON](allocator.json)。

```sh
just compare-allocator   # rebuild, verify, benchmark, update docs
just check-allocator     # same checks; .cache only
```
