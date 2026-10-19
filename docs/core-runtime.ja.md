# Core API リファレンス

[English](core-runtime.md) | 日本語

インストール、WIT-first な Component、npm 生成の手順は[利用ガイド](guide.ja.md)にあります。ここでは **Core/JS の独自 ABI** の二構成を定義します。標準 Component はこの lowering を通さず、wit-bindgen/jco の契約を使います。

CLI の `taraba build` は、生成された Wasm のランタイム import/export と WIT resource から Core の方式を自動選択します。`--jspi` / `--future` で強制指定できます。これはビルド時の判定で、実行時のフォールバックではありません。

## 実行契約

| 契約 | Core/JSPI | Core Future |
|---|---|---|
| Rust の import | 同期形の関数を JSPI が suspend | Promise resource を JsFuture に変換 |
| A が待機中の別の root 呼び出し | instance ごとのキューで待つ | 独立して進行できる |
| 任意の Pending Rust Future | executor なし | task slot のサイズ制限内で対応 |
| 明示的キャンセル | なし | JoinHandle.cancel / host.cancel |
| host reject / Wasm trap | 最初の fatal で instance を閉じる | fatal trap は閉じる。Promise Err の伝播は個別 task の reject にできる |
| fatal な JS 例外経路の Rust Drop | 保証しない | trap 後に Drop を再試行しない |
| WIT native async / record / string / list | 未対応 | 未対応。Component を使う |

JSPI の binding から同じ instance を await する再入はしないでください。外側の呼び出しは I/O 終了までキューを保持します。実行契約間の自動フォールバックはありません。

## WIT 境界

両方とも s32/u32/f64 と戻り値なしの関数に対応します。JSPI はこの scalar 境界に限定します。Future は JS の参照を保持する imported resource の own/borrow も扱い、borrow は import 引数に限定します。複数 interface からの同名関数 import は拒否します。

Future の雛形は次の opaque 契約です。

```wit
package example:app@0.1.0;
interface js { resource promise; }
world app {
  import js;
  use js.{promise};
  import add: func(a: s32, b: s32) -> promise;
  export run: func(a: s32, b: s32) -> promise;
}
```

resource は undefined 以外の JS 値を表し、Promise resource の import は Promise を返します。この Core ABI の handle は JS root であり、Canonical resource table の handle ではありません。生成された resource と JsPromise の変換はこの構成専用です。変換を書かずに型付き async 戻り値を表す場合は Component を選びます。

## 生成する JavaScript API

| 出力 | API |
|---|---|
| npm 指定なしの Core | `createHost({bindings})` → `host.imports` で標準 instantiation → `host.attach(instance.exports)`。呼び出しは、型のある `host.run(...)` |
| Core npm entry | `createHost({bindings})` → 標準 instantiation → `host.attach(instance.exports)`。呼び出しは、型のある `host.run(...)` |
| 両方 | `host.stats()` |
| Future のみ | `host.activeTasks()` と `host.cancel(token)` |

host は同じ host.imports で生成した一つの instance に一度だけ attach します。attach 後は raw の instance.exports の関数を直接呼ばず、host の API を使います。JSPI は attach 前の呼び出しを reject し、再 attach や閉じた host への attach を拒否します。

`index.js` と共有 `runtime.mjs` は `createHost` だけを export します。アプリ用の factory が型付き WIT メソッドを公開します。Wasm のロードには標準の `WebAssembly.instantiate`、`instantiateStreaming`、`new WebAssembly.Instance` を使い、その exports を attach します。

生成したアプリのメソッドは、両構成とも Promise を返します。共有ランタイム内部の呼び出しは `call(name, ...args)` の一つに揃え、Future の戻り値は生成メソッドで Promise にします。host に `promise`、`root`、`get`、`take`、`release` の別名は持たせません。`imports.jsrt` は Future の Wasm import 接続用であり、root/table/task は生成した所有権の変換や Rust executor に必要です。アプリからは型付きメソッドだけを呼びます。キャンセル対象の token は明示的に選びます。activeTasks はリクエストと token の安定した対応表ではありません。

通常の Core ビルドと npm 出力の両方で、WIT から `AppBindings`、`AppExports`、`AppHostOptions`、`AppHost` を生成します。`AppHost` は `AppExports` を継承し、WIT の export を Promise を返すメソッドとして直接呼べます。host の予約名は `imports`、`attach`、`stats`、`cancel`、`activeTasks`、`then` です。重複する WIT export は改名するか Component を使います。アプリ固有の `index.js` は共有可能な `runtime.mjs` を import するため、集約対象は runtime だけにします。scalar は number、opaque Promise resource の中身は **unknown** です。低水準 host の generic 型引数を付けても、実行時の値検査にはなりません。async 戻り値とドメイン値を WIT から型付けする場合は Component を使います。

## Rust Future crate

| API | 契約 |
|---|---|
| `JsPromise.await` | `Result<JsValue, JsValue>` を返す |
| `future_to_promise(future)` | 出力が `Result<JsValue, JsValue>` の static Future |
| `spawn_local(future)` | 出力 `()` の static Future。JoinHandle を返す |
| `JoinHandle.cancel()` | 生存中 task と subscription を明示的に Drop |
| JoinHandle の Drop | task を detach |
| `JoinHandle.into_promise()` | 完了 Promise を移譲 |
| JsValue の Clone / Drop | host root を retain/release。JS オブジェクトを複製しない |

allocator と no_std の panic handler はアプリが選びます。固定 task 領域は **1,024 × 128 B**、header・ID・Future 込みで、alignment は64以下です。大きな Future 向けの汎用 executor ではなく、容量超過・サイズ超過は fatal OOM です。Vec/Box 用 allocator は、この slot とは別です。JsValue / JsPromise は一つの JS agent と instance に限定します。共有メモリは Core のビルド時に拒否します。関数名・シグネチャ・bindings は WIT と生成 TS 型を契約とし、ランタイムでは型の再検証や SharedArrayBuffer の存在確認をしません。JSPI の接続対象は生成 API から渡します。attach/fatal 状態と Future の所有権・タスク状態の不変条件は実行時に検査します。

`JsFuture` の所有スロットは一つで、待機中は Promise、完了後は結果を保持します。完了時は Promise の root を解放してから、最後に登録した Waker を起こします。結果を取り出すと、その所有権を呼び出し側へ移します。subscription ID、外部 executor の Waker、キャンセル・Drop の保証は維持します。

`export_runtime!()` は private runtime export を一度定義します。Future 雛形はこれと所有権変換を供給します。利用コードから poll/drop/settle を呼んだり、生の handle を作ったりしないでください。

## エラー・機能・検証

Rust の panic を簡易な JS Error にするには、std は `taraba::panic::set_hook()`、no_std はアプリの handler から `taraba::panic::handler(info)` を使います。release は `PN01` と URL のみを通知します。[導入・debug の設定・サイズ上の限界](panic-reporting.md)。

Core の `--debug` は説明付きエラー、release は RT code と[エラーの説明ページ](error-codes.md)へのリンクを出力し、説明辞書は同梱しません。fatal は最初の理由を保って JS roots を解放します。キャンセルは任意の host network I/O の中止を意味しません。遅れて解決した subscription は無効化済み ID で処理します。Drop 中の trap でも instance を閉じ、Drop を再試行しません。

実行環境は Safari 27+ / JSPI 対応 V8 です。機能検出を挟まず、JSPI の組み込み API を直接呼びます。Safari 実機は未検証です。GC/js-string/exnref/funcref の機能検証と、通常ランタイムが全機能を使うことは区別します。

[検証手順](development.ja.md)、[現在のサイズ比較](async-size.ja.md)、[採用条件](jspi-adoption.md)。Kani は native64 の限定したモデル・部品の検証で、JS エンジン・生成 Wasm・ABI 全体の証明ではありません。
