# JSPI で Rust Future を駆動する実験

**未採用。製品 CLI / runtime の API・既定は変更しない。** Safari 27+ / JSPI 対応 V8 を前提とした試作。

```sh
just experiment-jspi-future  # 同じ二段 await のサイズ・時間計測
just check-jspi-future       # 検証のみ。測定レポートを更新しない
just miri-jspi-future        # Arc / ID driver と固定表の native Rust テスト
just kani-jspi-future        # ID Waker と固定表の限定 proof
just workers --jspi-future   # build / check-jspi-future 後。local workerd、未 deploy
```

## 比較する構成

- `adapter`: 最初の試作。stack 上の Future、safe Rust の `Arc<Wake>`、`RefCell<Vec<(id,Waker)>>`。
- `bounded`: ID だけを持つ Waker と、stack 上の16件固定登録表。Rust Future 本体も stack に pin する。一般的な heap allocator はリンクしない。
- `jspi`: 同期 import で直接待機する既存の scalar JSPI 構成。
- `core`: 既存の spawn_local / Rust Future 構成。

いずれも同じ `experiments/wit/shared/compute.rs` の二段 await と共通3,507ケース、同じ二回の host I/O・制御された二段待機を通す。これはアプリを含む比較で、機能が同一なランタイムの固定費ではない。[測定値](../../docs/jspi-future-measurements.md)、[JSON と入力ハッシュ](../../docs/jspi-future-experiment.json)を参照。

`bounded` のビルドは `--no-default-features --features bounded`（std は `bounded,std`）で選ぶ。省サイズ構成を暗黙に既定へ変更しない。WIT / wit-bindgen / Core lowering / wasm-opt を使い、実験用 host の差し替えは計測スクリプト内だけで行う。

## 固定表と allocator 除去

ID Waker は通知 ID のビットだけを持つ。Rust の allocation や stack-local な構造体へのポインターを持たず、clone/drop は資源を確保・解放しない。notify は安全な static 関数を呼ぶ。host は終了した ID を無視し、ID を再利用しない。generic な vtable の生成箇所を new/clone で共有し、Miri で複製後の比較も確認する。

Waker 登録表は `Waiters<16>`。wasm32 では表本体192 Bを stack に保持する。slot の再利用と job ID の再利用は別で、古い完了通知が新しい job を起こさない。登録が満杯なら17件目の I/O を開始する前に `JF1` で instance を閉じる。上限を変える場合は `CAPACITY` と境界テストを合わせて変更する。

`bounded` は Rust の alloc を参照する依存のリンク要件を満たすため、alloc/free が呼ばれると trap する sentinel を置く。これは heap allocator ではない。通常サンプルと allocator なしの probes がその sentinel の下で通過し、最小 Wasm に `memory.grow` が残っていないことも確認する。

固定表の RefCell は `try_borrow` を使い、競合時は説明文字列を含む Rust panic の代わりに `JF2` で停止する。std/no_std の例外経路もこの契約にそろえる。JS host は容量エラーを含めて first-fatal として扱う。

## 待機と子 Waker

`poll → Pending → JSPI park → 再 poll` で駆動する。管理用 import は同期、park だけが `WebAssembly.Suspending`。JS callback から Rust に再入せず、完了を JS キューへ置いて root を起こす。

Rust の Bridge は JSPI から戻った後、完了した job に登録された **実際の子 Waker** を呼んでから root を poll する。Waker の clone/drop/wake は RefCell の borrow を解除してから行う。

最初は root の通知だけで実装した。join / select は通ったが、子 Waker で ready queue を管理する FuturesUnordered は停止した。完了キューと Waker 登録は、一般的な Future combinator を使うために残る。

**FuturesUnordered 自体は動的確保する。** allocator なし構成にそのまま含めない。同じ ID driver / 固定表に allocator を有効にした `bounded,probes,heap-probes` 構成でも通すが、その Wasm は最小サイズの表へ混ぜない。join / select と制御された二段 await は allocator なしでも通す。

## 検証範囲

- native / Miri: Arc 版6件 + ID / 固定表6件。opaque ID の clone/drop/別スレッドの wake、登録容量・再利用・Waker 交換、非 Send Future、完了後の Waker、Future と signal の Drop 順序。
- Kani: 新しい ID Waker の全 u32 ID 保持、固定表を2スロットに実体化した容量・削除・再利用の計2 proof。native 64-bit の限定検証で、16スロットの全状態や JSPI エンジンの証明ではない。既存 `just kani` の6 proof とは分ける。
- 実 Wasm: std/no_std の共通3,507ケース、自己 wake 1,089回、join/select、逆順完了、敗者 Drop、古い完了通知、1 KiB Future を32回、reject/trap の first-fatal。
- 固定表: 16件すべてを逆順完了するケース、16件をまとめて Drop するケース、17件目の I/O 開始前に停止するケース。heap-probes では FuturesUnordered も確認。
- Node と local workerd で同じ検証を実行。Safari 27 実ブラウザーは未検証。

## 制約と判断

single-agent / 非共有 memory。同じ instance の guest entry は直列化する。一つの root 内で複数 I/O を進められるが、独立した root task を spawn する executor ではない。Future の poll は短時間で返し、JSPI で待つのは poll の外側とする。

他ランタイムの JS callback / Waker ABI、Tokio / Embassy の I/O・タイマー・spawn との互換性は提供しない。子 Future の Drop は動くが、外側の Promise のキャンセルや実行中 root の強制 Drop は未実装。job 解除は完了通知を無視するだけで、元の I/O を中止しない。

host reject / Wasm trap / JF1 / JF2 は instance を閉じ、Rust Drop / unwind を保証しない。JS の gate / job / completion queue を解放し、壊れた stack に再入しない。

最初の Arc + Vec 版は no_std の Wasm 3,291 Bのうち allocator 関数群が1,288 Bを占めていた。Future 本体を stack に置くだけでは、Arc / Vec 由来の allocator が残る。今回の固定版はその動的確保を除去する一方、登録上限という制約が加わる。比較 host には JF1/JF2 用 import を追加したため、前回の JS 2,848 Bから2,881 Bになっている。

最新の測定では bounded は Wasm 1,842 B + release JS 2,394 B = **4,236 B**。std/no_std の Wasm バイト列も一致した。同じ Wasm に debug JS 3,005 Bを合わせると4,847 B。時間の比較は[測定表](../../docs/jspi-future-measurements.md)を参照。

採用判断は保留する。固定表の制約と同一 instance の直列実行を既存版と同じ契約とは扱わない。

## Debug / Release の分離

`bundleHost()` は release、`bundleHost({ debug: true })` は debug を生成する。`just experiment-jspi-future` / `just check-jspi-future` は各構成に `host.mjs` と `host-debug.mjs` を出力する。**JS loader のビルド条件の違いであり、Wasm は両版とも同じ Rust release 最適化済みバイト列**を使う。

| 機能 | release | debug |
|---|---|---|
| `call` / `promise` | あり | あり |
| `stats()` と内部カウンター | 含まない | あり |
| ランタイム自身の `error.code` | `JF1` など | 同じコード |
| ランタイム自身の `error.message` | コードのみ | コードと説明文 |
| first-fatal / 容量・借用・ID上限・共有memoryの検査 | あり | あり |
| hostのreject理由 / Wasm trap | 元のオブジェクト | 元のオブジェクト |

`__JF_DEBUG__` を esbuild の define で固定し、release では説明辞書・診断用closure・カウンター更新・queued計数用のfinallyを削除する。安全性に関わる検査・解放処理は両版に残す。任意のエラーをコードで包まず、ホストがrejectした`undefined`やオブジェクト、Wasm trapの同一性を維持する。

エラー対応表は [error-codes.json](error-codes.json)。JF1 は16件の登録容量、JF2 は借用競合。例えばreleaseは`error.code === error.message === "JF1"`、debugは`error.code === "JF1"`と`error.message === "JF1: waiter capacity exceeded"`になる。説明辞書はrelease JSの実行に不要で、bundleへ含めない。JFコードは実験hostのもので、製品runtimeのRTコードと分ける。

動作probesは**同じWasmと同じ検証関数をrelease/debugの双方に実行する**。自己wake、join/select、FuturesUnordered、逆順完了、Drop、古い完了、1 KiB Future、reject/trap、JF1/JF2を確認する。`stats()`でしか観測できない内部の解放数・poll回数はdebugで追加検証する。

Dropをreleaseでも直接検証するため、WIT probesの`dropped` importを任意の`bindings.dropped`へ転送する（既定no-op、非関数ならJF14）。検証側で外から回数を数え、releaseへ診断カウンターを戻さない。通常の最小app Wasmはこのimportを持たないが、JS loaderは同じものを使う。

前回のJS 2,700 Bに対しreleaseは306 B減った。一時試算のコード文字列置換版とは異なり、安定した`error.code`とDrop callbackの転送・検査も含めた実測値。gate/完了キューの統合など、別の構造変更は今回に含めない。

## JS の private property mangling

`bundle.mjs` は minify に加え、末尾 `_` を内部propertyの目印として短縮する。jobの`ready_` / `value_`、gateの`notified_` / `waiter_`、waiterの`resolve_` / `reject_`、Gatesの補助メソッドが対象。hostとGatesを同じbundleで処理する。

WIT import名、`bindings.add` / `bindings.dropped`、公開`call` / `promise` / `stats`と診断キー、`error.code`、標準APIは短縮しない。外部とやりとりするpropertyにこのprivate目印を付けない。

計測スクリプトはreleaseの`host.mjs`と`host-unmangled.mjs`も比較する。同じWasmと全動作probesを通し、各ファイルのSHA-256と短縮名の対応表をJSONへ保存する。サイズは配信する一方のJSだけを加算する。各hostを4,096 task暖機後、各4,096 taskの11サンプルを交互順で測る。release/debugの時間比較も別の交互測定で保存する。Nodeとlocal workerdで両版の生成物を検証する。Safari 27実ブラウザーは未検証。

## Debug and release builds (English)

This unadopted JSPI Future experiment emits `host.mjs` (release) and `host-debug.mjs` from the same source, using `bundleHost({ debug: true })` to select debug. Both loaders use the exact same optimized Rust/Wasm binary. Release excludes `stats()`, diagnostic counters and the error-description table; debug includes all three. Runtime-owned errors have the same stable `error.code` in both builds. Release messages contain only the code, while debug messages also describe it. Foreign rejection reasons and Wasm traps retain their identity.

Both builds run the same 3,507 cases and behavioral probes, including Drop, cancellation effects, child Wakers, rejection/trap handling and capacity/borrow failures. Debug additionally inspects internal counters and cleanup. The optional WIT probe binding `bindings.dropped` forwards Drop notifications to the test harness without adding release counters. Safety checks and fatal cleanup remain enabled in both builds.

The bounded sample is 1,842 B Wasm plus 2,394 B release JS (4,236 B total), or 3,005 B debug JS (4,847 B total). Measurement JSON records hashes, all probe results and paired timings. Both variants are tested on Node and local workerd; Safari 27 has not been tested in a real browser.
