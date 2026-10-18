# Core API リファレンス

[English](core-runtime.md) | 日本語

インストール、WIT-first な Component、npm 生成の手順は[利用ガイド](guide.ja.md)にあります。ここでは **Core/JS の独自 ABI** の二構成を定義します。標準 Component はこの lowering を通さず、wit-bindgen/jco の契約を使います。

## 実行契約

| 契約 | 既定の Core/JSPI | Core Future（`--future`） |
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
| npm 指定なしの Core | `instantiate(source, {bindings})` と、管理された `host.call(name, ...args)` / `host.promise(name, ...args)` |
| Core npm entry | `instantiate(source, {bindings})` と、型のある `host.exports.run(...)` |
| 両方 | `host.stats()` |
| Future のみ | `host.activeTasks()` と `host.cancel(token)` |

source は BufferSource またはコンパイル済み WebAssembly.Module です。JSPI の call/promise は両方 Promise を返します。Future の call は直接の戻り値、promise はそれを Promise として受けます。npm のアプリ export は両方とも Promise を返します。root/table/rt_* は非公開 ABI なので、管理された呼び出しを通します。キャンセル対象の token は明示的に選びます。activeTasks はリクエストと token の安定した対応表ではありません。

TS の AppBindings/AppExports は WIT から生成します。scalar は number、opaque Promise resource の中身は **unknown** です。低水準 host の generic 型引数を付けても、実行時の値検査にはなりません。async 戻り値とドメイン値を WIT から型付けする場合は Component を使います。

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

allocator と no_std の panic handler はアプリが選びます。固定 task 領域は **1,024 × 128 B**、header・ID・Future 込みで、alignment は64以下です。大きな Future 向けの汎用 executor ではなく、容量超過・サイズ超過は fatal OOM です。Vec/Box 用 allocator は、この slot とは別です。JsValue / JsPromise は一つの JS agent と instance に限定します。atomics/shared memory は対象外です。

`export_runtime!()` は private runtime export を一度定義します。Future 雛形はこれと所有権変換を供給します。利用コードから poll/drop/settle を呼んだり、生の handle を作ったりしないでください。

## エラー・機能・検証

Core の `--debug` は説明付きエラー、release は短い RT code と外部 error-codes.json を出力します。fatal は最初の理由を保って JS roots を解放します。キャンセルは任意の host network I/O の中止を意味しません。遅れて解決した subscription は無効化済み ID で処理します。Drop 中の trap でも instance を閉じ、Drop を再試行しません。

実行環境は Safari 27+ / JSPI 対応 V8 です。JSPI がなければ RT15 で失敗します。Safari 実機は未検証です。GC/js-string/exnref/funcref の機能検証と、通常ランタイムが全機能を使うことは区別します。

[検証手順](development.ja.md)、[現在のサイズ比較](async-size.ja.md)、[採用条件](jspi-adoption.md)。Kani は native64 の限定したモデル・部品の検証で、JS エンジン・生成 Wasm・ABI 全体の証明ではありません。
