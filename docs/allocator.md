# Allocator のサイズ・速度検証

2026-10-19T01:23:59.169Z

Node v24.21.0 / V8 13.6.233.17-node.53; rustc 1.98.0 (88d9e12ae 2026-08-18); Binaryen 133。変更前は 44bf8b09c61a53368e28821874ab874258f6b1cd。

同じ Rust kernel と allocator oracle を使い、同じ wasm-opt 設定で比較する。Wasm は probe・検証・計算コードを含み、allocator 単体の固定費ではない。全体の oracle に失敗した wee_alloc は同等性を満たす比較対象から除外する。以下の時間は同じ検査を通った変更前後だけを測り、wee_alloc が高速かどうかの順位は付けない。

| 構成 | mode | classes | Wasm B | 全体 oracle |
|---|---|---|---:|---|
| before | no_std | off | 3281 | pass |
| before | no_std | on | 3795 | pass |
| before | std | off | 10082 | pass |
| before | std | on | 10587 | pass |
| current | no_std | off | 2961 | pass |
| current | no_std | on | 3471 | pass |
| current | std | off | 9663 | pass |
| current | std | on | 10180 | pass |
| wee | no_std | off | 2934 | 隣接領域の再利用で失敗 |
| wee | no_std | on | 3486 | 隣接領域の再利用で失敗 |
| wee | std | off | 9420 | 隣接領域の再利用で失敗 |
| wee | std | on | 9963 | 隣接領域の再利用で失敗 |

21回の測定順を循環させた中央値 ns/job。JIT・instance 生成は除外し、各 sample で結果と memory plateau を確認する。JS→Wasm 呼び出しを含む V8 上の結果で、Criterion/Wasmtime の過去結果とは混ぜない。

| mode / classes / kernel | 変更前 | 現在 | wee_alloc（除外） |
|---|---:|---:|---:|
| no_std / off / boundary | 8.5 | 8.5 | excluded |
| no_std / off / pair_32 | 12.7 | 9.1 | excluded |
| no_std / off / pair_1024 | 12.0 | 9.2 | excluded |
| no_std / off / aligned_4096 | 12.2 | 9.1 | excluded |
| no_std / off / burst_fifo | 15.9 | 13.3 | excluded |
| no_std / off / burst_lifo | 15.0 | 12.7 | excluded |
| no_std / off / grow_realloc | 33.1 | 28.5 | excluded |
| no_std / off / coalesce | 15.1 | 12.4 | excluded |
| no_std / on / boundary | 8.5 | 8.4 | excluded |
| no_std / on / pair_32 | 17.2 | 16.4 | excluded |
| no_std / on / pair_1024 | 16.5 | 15.7 | excluded |
| no_std / on / aligned_4096 | 16.5 | 15.9 | excluded |
| no_std / on / burst_fifo | 16.8 | 15.8 | excluded |
| no_std / on / burst_lifo | 15.3 | 15.2 | excluded |
| no_std / on / grow_realloc | 38.3 | 36.2 | excluded |
| no_std / on / coalesce | 19.7 | 18.2 | excluded |
| std / off / boundary | 8.5 | 8.4 | excluded |
| std / off / pair_32 | 11.5 | 10.2 | excluded |
| std / off / pair_1024 | 11.9 | 10.7 | excluded |
| std / off / aligned_4096 | 11.4 | 10.5 | excluded |
| std / off / burst_fifo | 15.4 | 12.2 | excluded |
| std / off / burst_lifo | 14.2 | 11.5 | excluded |
| std / off / grow_realloc | 30.7 | 26.7 | excluded |
| std / off / coalesce | 15.6 | 13.2 | excluded |
| std / on / boundary | 8.5 | 8.5 | excluded |
| std / on / pair_32 | 15.2 | 15.1 | excluded |
| std / on / pair_1024 | 15.1 | 15.5 | excluded |
| std / on / aligned_4096 | 15.1 | 15.0 | excluded |
| std / on / burst_fifo | 15.7 | 14.9 | excluded |
| std / on / burst_lifo | 14.8 | 14.5 | excluded |
| std / on / grow_realloc | 36.8 | 34.7 | excluded |
| std / on / coalesce | 20.0 | 18.1 | excluded |

全 sample、入力 SHA、Wasm SHA、再利用・OOM・realloc の結果は [JSON](allocator.json)。

```sh
just compare-allocator   # rebuild, verify, benchmark, update docs
just check-allocator     # same checks; .cache only
```
