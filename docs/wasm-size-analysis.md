# Wasm サイズの内訳と snip の実験

2026-10-19T09:54:39.606Z / Node v24.21.0 / V8 13.6.233.17-node.53

同じ二段 await の共通3,507ケースで、JSPI/Future × std/no_std を比較した。全 runnable variant で実際の二回の host I/O、待機の順序、reject の同一性と再利用/first-fatal の契約を検証済み。Safari 向け検証は[WebKit E2E の方針](browser-testing.ja.md)に従う。製品の最適化ポリシーは変更していない。

`just analyze-wasm-size` は通常のサイズ比較を再ビルドしてから、twiggy 0.8.0 / wasm-snip 0.4.0 / Binaryen 133 / wasm-tools 1.245.1 で再現する。入力と成果物の SHA-256、全 variant、twiggy の top/retained/paths は [JSON](wasm-size-analysis.json) に記録する。

## custom section と data section

custom section（ID 0）は名前・DWARF・producer 等のメタデータ。data section（ID 11）は線形メモリの初期値で、文字列だけでなく Waker/task の vtable なども含む。両者は別物で、data を一括削除する処理は行わない。

| 構成 | 配布 Wasm B | code section B | data section B | custom section B |
|---|---:|---:|---:|---:|
| jspi-no_std | 248 | 160 | 11 | 0 |
| jspi-std | 5227 | 4398 | 657 | 0 |
| future-no_std | 1712 | 1298 | 31 | 0 |
| future-std | 6803 | 5610 | 749 | 0 |

section の数値は ID/長さのヘッダー込み。残りは型、import/export、table、global、element 等。raw の DWARF/name は大きいが既定の CLI が除去済み。`wasm-tools strip --all` 後も配布バイナリの SHA-256 は同一だった。

## 比較結果

| 操作 | JSPI no_std B | JSPI std B | Future no_std B | Future std B |
|---|---:|---:|---:|---:|
| baseline | 248 | 5,227 | 1,712 | 6,803 |
| strip-all | 248 | 5,227 | 1,712 | 6,803 |
| reopt | 248 | 5,221 | 1,712 | 6,797 |
| memory-packing | 248 | 5,221 | 1,712 | 6,797 |
| strip-raw-custom | 1,332 | 5,339 | 2,785 | 6,912 |
| snip-roundtrip | 248 | 5,227 | 1,712 | 6,803 |
| snip-fmt | 248 | 2,387 | 1,712 | 4,441 |
| snip-panic | 248 | 894 | 1,712 | 3,045 |
| snip-both | 248 | 894 | 1,712 | 3,045 |

`reopt` は配布 Wasm に Oz/converge を再適用した対照。`memory-packing` は同じ処理に当該 pass を追加。`snip-roundtrip` は除去対象なしで wasm-snip を通した対照であり、再エンコードの影響を除去効果と混同しない。snip は名前が残る Rust 出力に適用し、その後、通常と同じ Core lowering・pool merge・Oz/flatten/rereloop/Oz/converge を行った。JS のサイズはこの表に含めない。

strip-raw-custom は Core lowering より前に custom section を除去した順序の対照。Canonical ABI の metadata を先に失うと補助 export の除去判断に影響し、今回の4構成はすべて大きくなった。各 variant の export 一覧も JSON に記録する。この実験の対象は Core であり、Component の型 metadata の削除可否とは分けて扱う。

snip 後も data section の文字列が残り得る。関数を trap に置換しても、線形メモリの初期値すべてを削除できるという意味ではない。詳細な文字列と section サイズは JSON に残した。

名前を除去した後の wasm-snip も試した。JSPI は読み込めるが名前による対象指定はできず、Future の externref table は wasm-snip 0.4.0 の parser が invalid table type として拒否した。名前が残り、Core lowering より前の Rust 出力に適用する順序が必要だった。

## twiggy の内訳

配布済み Wasm の top は `code[n]` になるため、全 Binaryen 段で名前を保つ解析専用の view も作った。追加した名前は配布サイズに計上しない。非 custom section ごとのサイズ一致を検証しているが、関数・型の index 順序が変わることがあり、バイト列同一とは扱わない。下表は Future/std の解析 view の shallow size。

| B | 項目 |
|---:|---|
| 969 | <&str as core[f0fd674eaa06beef]::fmt::Display>::fmt |
| 721 | data segment ".rodata" |
| 488 | core[f0fd674eaa06beef]::fmt::write |
| 416 | taraba[38109ee7e3c1101c]::task::poll_task::<<size_core[729556e9b48cdef3]::App as size_core[729556e9b48cdef3]::Guest>::run::{closure#1}> |
| 388 | <size_core[729556e9b48cdef3]::App as size_core[729556e9b48cdef3]::Guest>::run::{closure#0}::{closure#0} |
| 363 | <taraba_allocator[47b9a535ac3d2974]::WeeAlloc as core[f0fd674eaa06beef]::alloc::global::GlobalAlloc>::dealloc |
| 314 | taraba_allocator[47b9a535ac3d2974]::alloc_first_fit |
| 258 | <alloc[ae94343a5edb5677]::string::String as core[f0fd674eaa06beef]::fmt::Write>::write_char.74 |
| 256 | <alloc[ae94343a5edb5677]::raw_vec::RawVecInner<_>>::reserve::do_reserve_and_handle::<alloc[ae94343a5edb5677]::alloc::Global> |
| 225 | std[2b356c9112ee3216]::panicking::panic_with_hook |
| 223 | <std[2b356c9112ee3216]::panicking::panic_handler::FormatStringPayload as core[f0fd674eaa06beef]::panic::PanicPayload>::take_box |
| 214 | externref_export_run |

retained size は支配関係に依存し、各行を単純に足して除去量とはしない。fmt の保持経路には panic payload と funcref table が見える。実際に消せた量は上の snip の差分で判断する。poll_task の数値にはアプリの Future の poll が inline された部分も含まれ、ランタイム単体の固定費ではない。

## 意味が変わることの確認

通常経路のテストが通っても、全アプリへ無条件に適用できるわけではない。別の std fixture で動的な `format!("value={n}")` と panic hook を確認した。

| 操作 | 動的 format | panic hook 呼び出し数 |
|---|---|---:|
| baseline | passed | 1 |
| snip-fmt | trapped | 1 |
| snip-panic | passed | 0 |
| snip-both | trapped | 0 |

fmt snip は正規の formatting 経路を trap にし、panicking snip は hook の設定・呼び出しを含む panic 契約を変える。現時点では opt-in の実験として扱う。custom section だけを除く strip とは意味が異なる。

[twiggy](https://github.com/rustwasm/twiggy) / [wasm-snip の実装](https://docs.rs/wasm-snip/0.4.0/src/wasm_snip/lib.rs.html) / [現在の通常ビルド比較](async-size.ja.md)

## 追記: 型付き Core async の軽量化（2026-10-20）

同じ二段 await の型付き Core binding で、出力の `async move { future.await.map(...) }` を、Future を移動せずに poll 結果を変換する adapter に置き換えた。利用側の WIT と `async fn` は変更しない。JS は Rolldown に統一し、アプリ用 factory で private な dispatch 関数だけを取り出し、公開 host の重複した組み立てを省いた。

wasm-opt と JS minify 後の非圧縮サイズ。アプリ全体の比較で、ランタイム単体の固定費ではない。

| Rust | Wasm: 変更前 → 変更後 B | JS: 変更前 → 変更後 B | 合計: 変更前 → 変更後 B |
|---|---:|---:|---:|
| no_std | 1,712 → 1,571 | 3,620 → 3,520 | 5,332 → 5,091 |
| std | 6,803 → 6,636 | 3,620 → 3,520 | 10,423 → 10,156 |

Brotli 合計も no_std は 2,678 → 2,558 B、std は 5,028 → 4,918 B に減った。共有 JS ランタイム単体は 3,470 → 3,410 B。生成アプリ用 JS と共有ランタイムをまとめた値が上表の JS 列になる。

変更後の std Wasm を `taraba insight` で調べると、関数本体の shallow size は formatting 1,954 B、panic 941 B、allocator 1,291 B、それ以外（アプリ・executor・ABI 変換を含む）1,270 B。data section は別に733 Bある。まだ std の panic・整形・割り当て経路が大きく、これらを trap に置き換える snip は上記のとおり契約を変えてしまう。

wasm-opt の GUFA、類似関数の統合、inline 閾値の変更も比較したが、後段の再最適化は今回の対照で no_std が最大1 B、std が最大6 Bの削減にとどまり、既定の最適化設定は変更しなかった。公開 API、JS エラーの identity、キャンセル後の解放は維持する。pin の位置維持と Drop は native の専用テストと Miri で検査する。

[最新の42構成の測定・共通3,507ケース](async-size.ja.md)、[解析コマンド](insight.ja.md)。
