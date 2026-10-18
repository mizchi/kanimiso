# JSPI を既定の実行基盤にする

JSPI を標準とし、Rust Future 対応は必要時に追加する。既存 Future バックエンドは移行条件を満たすまで維持する。直接 JSPI と Rust Future は同じ層の機能ではなく、JSPI 上でも Future の poll・子 Waker・Drop を扱うアダプターが必要になる。

## 今回の変更

`taraba new` と `taraba build` は直接 JSPI を既定とする。`--jspi` は明示指定として維持し、従来の Future 構成には両コマンドで `--future` を指定する。二つのフラグの併用はエラー。WIT の内容からバックエンドを自動選択しない。Rust の build API も `ExecutionProfile::{Jspi, Future}` で区別する。

```sh
# JSPI: 既定
taraba new hello --no-std
taraba build raw.wasm --wit wit --out-dir pkg

# 既存 Future: 比較・必要な機能のために維持
taraba new hello-future --no-std --future
taraba build future-raw.wasm --wit wit --out-dir pkg-future --future
```

従来の Future アプリをビルドするコマンドにも `--future` が必要になる。resource / runtime imports を含むアプリを既定 JSPI でビルドしても、黙って別の ABI に切り替えない。`std` と `no_std` の選択はバックエンド選択とは独立。

JSPI 上の Future アダプターは引き続き [experiments/jspi-future](../experiments/jspi-future/README.md) で検証する。製品 CLI に新しい Future アダプター用オプションはまだ追加しない。`--future` は既存 executor を選ぶもので、実験アダプターを選ぶフラグではない。

## 現在の契約

| 項目 | 既定の直接 JSPI | 既存 `--future` | 実験 JSPI＋Future |
|---|---|---|---|
| ホスト境界 | scalar WIT | scalar / imported resource | 実験用 driver imports |
| 待機状態 | JSPI の停止した stack | pool 上の Future | stack 上の Future と JSPI park |
| 独立した呼び出し | instance 内で直列 | I/O 待機中も他のタスクを進める | instance 内で直列 |
| 任意の Pending Future | executor なし | 対応。slot のサイズ・alignment 上限あり | driver の範囲で対応 |
| join / select | Rust Future 用 driver なし | Future による合成 | 子 Waker と Drop を probe 済み |
| root のキャンセル | API なし | 既存 cancel / Drop 契約 | 未実装 |
| host reject | instance を閉じる | Promise rejection を Rust の Result へ渡す | instance を閉じる |
| trap | instance を閉じる | instance を閉じる | instance を閉じる |

直接 JSPI では、遅い呼び出しの I/O 待ちが同一 instance の後続呼び出しを待たせる。binding が同じ instance の呼び出しを await すると進行できない。queue を取り除くだけでは、LLVM が線形メモリに置く stack を保護できない。

JSPI の reject / trap で Rust の Drop が走るとは仮定しない。Promise の参照を捨てることも Rust Future のキャンセルとは扱わない。実験アダプターの子 Future の Drop は登録を解除するが、元の JS I/O 自体を abort する保証はない。

## 速度・サイズの判断

[保存済みの比較](jspi-future-measurements.md)では、同じ二段 await / 3,507 ケースを通した no_std 例で、既存 Future は合計5,618 B・1.137 μs/task、直接 JSPI は1,572 B・0.550 μs/task、bounded アダプターは4,236 B・1.196 μs/task。アプリを含む値であり、機能が同一なランタイムの固定費ではない。

この速度測定は即座に解決する Promise の二段 await を対象にする。実ネットワーク待ち、多数の停止 stack のメモリ、Web Server の同時リクエスト性能を測った値ではない。Future アダプターに既存版を上回る速度の優位があるとはまだ判断しない。既定の変更自体を新しいサイズ改善として数えない。

## 既存バックエンドを削除する条件

以下を満たすまで `--future` と比較用 fixture を維持する。

1. **同一 instance の独立した処理を進める。** A の I/O が停止していても B が開始・完了する。LLVM の stack 分離・保存復元だけでなく、共有状態の借用と再入のルールを定義する。Rust の実 spill を保持した複数呼び出しで、逆順・非 LIFO・同時完了・trap を検証する。
2. **キャンセルとエラーの契約を決める。** root の中断、Drop の回数、子 Future の解放、遅れた完了通知、I/O abort の責任を明示する。recoverable な失敗と instance-fatal を区別し、expected error まで全 instance を閉じる設計にしない。
3. **同時実行時も計測する。** 同じアルゴリズム・同じ成功ケースと I/O 契約を維持し、即時 Promise、制御された遅延、長短混在の I/O で throughput・待ち時間・停止 task 当たりのメモリを比較する。Wasm/JS の配信サイズと実行時メモリは別々に記録する。
4. **対象エンジンで確認する。** JSPI 対応 V8 と Safari 27 以降の実ブラウザーで検証する。現状 Safari 27 実ブラウザーは未検証。Kani/Miri の部品検証をエンジン全体の証明と扱わない。
5. **既存 API の利用範囲を扱う。** resource own/borrow、spawn_local、キャンセルを使う consumer の移行方法を用意する。scalar の共通成功ケースだけを根拠に、機能が同等だとは判断しない。

## 回帰検証

`tests/support/scheduling.mjs` は、同じ二段の加算で A / B を投入し、A を停止したまま B の I/O だけを解決する。直列構成では A→B、既存 Future では B→A になることを確認する。タイマーや速度の閾値で並行性を判定しない。

- `just check`: 製品の release/debug × std/no_std で、共通成功ケース・Rust spill・各構成の scheduling 契約を確認する。
- `just package-check`: archive からインストールした CLI で、フラグなしの JSPI と明示 `--future` をビルドし、型・metadata・I/O・scheduling・reject を検証する。公開処理は行わない。
- `just check-jspi-future`: 同じ Rust の `shared/compute.rs` を使う全8構成と、アダプターの release/debug / mangling 条件で scheduling も確認する。実験アダプターを自動採用しない。

結果は `.cache/check.json`、`.cache/jspi-check.json`、`.cache/package-check.json`、`.cache/jspi-future-experiment/check.json` に保存する。既存の計測 JSON は記録日時時点のスナップショットとして扱う。
