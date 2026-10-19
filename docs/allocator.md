# Allocator のサイズ・速度検証

2026-10-19T01:32:50.543Z

Node v24.21.0 / V8 13.6.233.17-node.53 (--no-liftoff); rustc 1.98.0 (88d9e12ae 2026-08-18); Binaryen 133。変更前は 44bf8b09c61a53368e28821874ab874258f6b1cd。

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

最適化済み Wasm（--no-liftoff）に固定し、kernel/instance ごとに50 ms以上ウォームアップ。21回の測定順を循環させた中央値 ns/job。JIT・instance 生成は除外し、各 sample で結果と memory plateau を確認する。数%の差や今回1回の測定だけで速度の優劣を断定しない。JS→Wasm 呼び出しを含む V8 上の結果で、Criterion/Wasmtime の過去結果とは混ぜない。

| mode / classes / kernel | 変更前 | 現在 | wee_alloc（除外） |
|---|---:|---:|---:|
| no_std / off / boundary | 8.3 | 8.3 | excluded |
| no_std / off / pair_32 | 6.7 | 6.4 | excluded |
| no_std / off / pair_1024 | 7.2 | 6.5 | excluded |
| no_std / off / aligned_4096 | 6.8 | 6.5 | excluded |
| no_std / off / burst_fifo | 14.3 | 13.8 | excluded |
| no_std / off / burst_lifo | 14.2 | 13.7 | excluded |
| no_std / off / grow_realloc | 27.9 | 26.9 | excluded |
| no_std / off / coalesce | 9.9 | 10.2 | excluded |
| no_std / on / boundary | 8.3 | 8.2 | excluded |
| no_std / on / pair_32 | 9.1 | 8.9 | excluded |
| no_std / on / pair_1024 | 10.9 | 9.1 | excluded |
| no_std / on / aligned_4096 | 10.8 | 9.1 | excluded |
| no_std / on / burst_fifo | 20.6 | 20.4 | excluded |
| no_std / on / burst_lifo | 20.2 | 20.2 | excluded |
| no_std / on / grow_realloc | 41.9 | 43.1 | excluded |
| no_std / on / coalesce | 17.4 | 18.1 | excluded |
| std / off / boundary | 8.3 | 8.3 | excluded |
| std / off / pair_32 | 10.4 | 10.4 | excluded |
| std / off / pair_1024 | 10.2 | 10.5 | excluded |
| std / off / aligned_4096 | 10.4 | 10.5 | excluded |
| std / off / burst_fifo | 16.4 | 16.0 | excluded |
| std / off / burst_lifo | 16.5 | 16.2 | excluded |
| std / off / grow_realloc | 32.0 | 30.3 | excluded |
| std / off / coalesce | 14.2 | 13.7 | excluded |
| std / on / boundary | 8.3 | 8.3 | excluded |
| std / on / pair_32 | 14.4 | 13.6 | excluded |
| std / on / pair_1024 | 17.4 | 15.9 | excluded |
| std / on / aligned_4096 | 17.2 | 16.2 | excluded |
| std / on / burst_fifo | 21.0 | 20.8 | excluded |
| std / on / burst_lifo | 20.7 | 20.7 | excluded |
| std / on / grow_realloc | 42.8 | 42.1 | excluded |
| std / on / coalesce | 19.5 | 19.3 | excluded |

全 sample、入力 SHA、Wasm SHA、再利用・OOM・realloc の結果は [JSON](allocator.json)。

```sh
just compare-allocator   # rebuild, verify, benchmark, update docs
just check-allocator     # same checks; .cache only
```
