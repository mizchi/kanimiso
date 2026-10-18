# JSPI で Rust Future を駆動する実験

**未採用。製品 CLI / runtime の API は変更しない。** Safari 27+ / JSPI 対応 V8 を前提とした別構成の試作。

```sh
just experiment-jspi-future  # 検証 + 同じ二段 await のサイズ・時間計測
just check-jspi-future       # 検証のみ。性能測定や測定レポートの更新をしない
just miri-jspi-future        # driver の native Rust テスト
just workers --jspi-future   # build / check-jspi-future 後。local workerd、未 deploy
```

## 構造

- `adapter`: `no_std + alloc` の single-root driver。Future は呼び出し元のスタックに pin し、safe Rust の `Arc<Wake>` を一つ作る。`poll → Pending → JSPI park → 再 poll`。Rust task pool は持たない。
- `Signal`: wake 通知を保持する latch。poll 中や park の直前の通知も次の park が消費する。wake の重複はまとめてよい。通知 ID は再利用しない。
- `host.mjs`: 管理用 import は同期、park だけが `WebAssembly.Suspending`。JS の Promise callback から Rust へ再入しない。完了を JS キューへ置いて root を起こす。
- Rust の `Bridge`: JSPI から戻った後、完了した job に登録された **実際の子 Waker** を呼んでから root を poll する。登録は `RefCell<Vec<(id,Waker)>>` で、探索は O(n)。Future の登録先 Waker が変われば更新する。

WIT はスカラー import/export を定義し、`wit-bindgen` と既存 CLI の Core lowering / wasm-opt を使う。実験用 host への差し替えは実験スクリプト内だけで行い、製品の `--jspi` loader はそのまま維持する。

## 分かったこと

最初は root の通知だけで動かした。`join` / `select` は通ったが、子 Waker で ready queue を管理する `FuturesUnordered` は停止した。単純な `Pending → park` だけでは、JS I/O と任意の Future combinator の接続は完成しない。上記の完了キューと Waker 登録を加えると同じテストを通過した。

独立した native テストでは Ready、自己 wake・重複 wake、外部スレッドの wake、非 Send Future、完了後の Waker、panic 時の Drop 順序を検証する。実 Wasm では共通3,507ケースと制御された二段待機に加え、自己 wake 1,089回、futures-util 0.3.31 の join / select / FuturesUnordered、逆順完了、敗者 Drop、古い完了通知、1 KiB Future を32回保持する待機を検証する。

## 制約

- single-agent / 非共有 memory。同じ instance の guest entry は直列化する。複数の I/O Future は一つの root 内で同時に進められるが、複数の独立した root task を spawn する executor ではない。
- Future の poll は通常の契約どおり短時間で返す。JSPI で待つのは poll の外側。実験用 `Add` はこの bridge に接続した Future であり、wasm-bindgen-futures / Tokio / Embassy の I/O・タイマー・spawn との互換性を提供したわけではない。
- `select` 等による **子 Future の Drop** は動く。外側の JS Promise のキャンセルや実行中 root の強制 Drop は未実装。子 job の解除は JS の完了通知を無視するだけで、元の I/O を中止するわけではない。
- host reject / Wasm trap は first-fatal とし、instance を閉じる。待機中の Rust Drop / unwind は保証しない。JS の gate / job / completion queue を解放し、壊れたスタックへ再入しない。
- Arc Waker と登録 Vec は allocator を使う。Future 自体の heap allocation を省いても、Rust Future の状態機械・Waker・I/O 登録のコストは残る。
- 同期 import の bookkeeping が throw しないことが通常経路の前提。失敗すれば fatal。JSPI 非対応環境への fallback は用意しない。
- Safari 27 実ブラウザーは未検証。Kani の既存 proof はこの driver や JSPI エンジンの証明ではない。Miri は native Rust の検証で、JSPI の実行検証とは分ける。

## 今回の判断材料

[同条件の測定](../../docs/jspi-future-measurements.md)では、no_std の Wasm + JS は試作6,139 B、既存 Future 版5,618 B（試作が521 B大きい）。JS は1,026 B減った一方、Wasm は1,547 B増えた。std は試作10,376 B、既存版11,088 B（試作が712 B小さい）。速度は中央値が約1.2–1.3 μs/task で近く、サンプルの分布も重なる。速度差の有意性は主張しない。

実装できた利点は、固定 task slot を使わず Future をスタックに保持し、通常の Future combinator を駆動できること。ただし、I/O を bridge へ接続するコストと、Waker・完了配送の管理は残る。root を直列化する制約や fatal 契約も既存版と違うため、既存版の全面置き換えと評価する材料には不足する。JS 非同期 I/O の順次実行だけなら直接 JSPI の1,572 Bが小さい。

採用判断は保留する。製品の既定や既存 Future 構成は変更しない。
