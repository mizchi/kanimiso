# Error codes / エラーコード

Core JSPI / Future のランタイムエラーを調べるページです。release のメッセージはコードと、このページの該当見出しへの URL だけを持ちます。`--debug` は説明文も含みます。説明辞書は生成物・npm パッケージには同梱しません。

Core JSPI / Future runtime errors link directly to a heading below. Release messages contain only a code and its URL; `--debug` also includes a description. Generated output and npm packages do not ship a description dictionary.

```text
Error: RT12 https://github.com/mizchi/taraba/blob/main/docs/error-codes.md#rt12
```

プログラム上の分岐には `error.code` を使います。`message` の文字列を解析しないでください。JS のコールバック由来の例外や Wasm エンジンの例外は、同じオブジェクトを伝播し、メッセージを書き換えません。

Use `error.code` for programmatic handling. Callback exceptions and native Wasm errors keep their original identity, code and message.

## RT01

**invalid token range**

Future の token 範囲が不正です。`tokens.first` / `tokens.last` は整数で、`1 ≤ first ≤ last ≤ 4,294,967,295` が必要です。

The Future token range must contain integers satisfying `1 ≤ first ≤ last ≤ 4,294,967,295`.

## RT02

**invalid value limit**

`maxValues` は `1` から `4,294,967,294` までの整数にしてください。これは JS 値を保持する private root 数の上限です。

`maxValues` must be an integer from `1` to `4,294,967,294`, limiting live private JS roots.

## RT03

**Wasm allocation failed**

Wasm のアロケーション、JS 値の table 拡張、または root 数の上限に達しました。不要な値・タスクを解放し、メモリ制限と Future のサイズを確認してください。このエラーは `RangeError` で、互換性のため `name` は `WasmOutOfMemoryError`、`error.code` は `ERR_WASM_OOM` です。メッセージとリンクは `RT03` を使います。

Allocation, value-table growth or the configured root limit failed. Check memory limits, Future size and retained values/tasks. For compatibility, this `RangeError` has `name = 'WasmOutOfMemoryError'` and `code = 'ERR_WASM_OOM'`; its message links to `RT03`.

## RT04

**runtime token IDs exhausted; create a new instance**

Future の単調増加 token ID を使い切りました。遅れて届く完了通知との混同を防ぐため、ID は再利用しません。新しい host と Wasm instance を作ってください。

Monotonically increasing Future token IDs are exhausted. IDs are not reused because late completions must not refer to another task. Create a new host and Wasm instance.

`taraba-helpers` の RegExp、および文字列・Iterator 等の共通 root の ID 枯渇も同じコードを使います。ID は再利用せず、新しい host / instance へ切り替えます。

RegExp and the shared string/iterator helper registry also use this code when their monotonically increasing handle IDs are exhausted; create a new host/instance.

## RT05

**invalid private value slot**

private root の retain/release の対応が崩れています。通常の WIT API を使い、生の handle を作ったり、同じ root を二重に消費したりしないでください。

A private root was retained/released incorrectly. Use the generated WIT API; do not fabricate handles or consume a root twice.

## RT06

**runtime not attached**

Wasm の export がまだ host に接続されていません。`WebAssembly.instantiate(bytes, host.imports)` の後に `host.attach(instance.exports)` を一度呼んでから、生成されたメソッドを使います。

Attach the instance's exports once after native instantiation, before calling generated methods.

## RT07

**ready task missing outcome**

Future の poll が完了を返したのに、成功・失敗の結果が登録されていません。private runtime ABI または Future 実装の不整合です。`rt_*` を直接呼ばず、Rust と JS が同じビルドの生成物か確認してください。

A Future reported completion without registering an outcome. Check for a private ABI/Future implementation mismatch and use matching Rust/JS output.

## RT08

**pending task has an outcome**

Future が Pending を返したのに完了結果が登録されています。private ABI の状態遷移が不整合です。対応する生成物を使い、再現する場合は不具合として報告してください。

A pending Future already has an outcome. This indicates an inconsistent private ABI state transition; check matching artifacts and report a reproducible runtime bug.

## RT09

**task cancelled**

Future のタスクが明示的にキャンセルされました。`error.name` は `AbortError` です。Rust の task と subscription を解放しますが、既定では元の JS I/O は abort しません。`--abort-signal` ビルドでは呼び出しの context.signal も abort するので、fetch などへその signal を渡してください。外部 AbortSignal からのキャンセルは RT09 に置き換えず、signal.reason をそのまま返します。

A Future task was explicitly cancelled. The error's name is `AbortError`. Cancellation releases Rust task/subscription state. The default build does not abort JS I/O. With `--abort-signal`, the call's context.signal is also aborted; pass it to fetch or another cooperating API. External signal cancellation preserves signal.reason rather than replacing it with RT09.

## RT10

**duplicate task outcome**

同じ Future タスクへ結果を複数回登録しようとしました。private ABI の不整合です。生成された runtime を使い、`task_finish` などをアプリから直接呼ばないでください。

A Future task's outcome was registered twice. Use the generated runtime and do not invoke private completion imports directly.

## RT11

**private runtime ABI**

Future の低水準呼び出しから private な `rt_*` export へアクセスしようとしました。生成された `host.run(...)` などのアプリ API を使ってください。

A low-level Future call attempted to access a private `rt_*` export. Use generated application methods instead.

## RT12

**runtime already attached/closed**

同じ host への再 attach、または fatal 後の attach です。host と instance は一対一です。再実行には新しい host と instance を作ってください。

The host was already attached or has been closed by a fatal error. Each host owns one instance; create a new pair to restart.

## AL01

**allocator free-list invariant**

allocator が隣接 free cell を結合する際、その cell が free list に見つかりませんでした。通常のメモリ不足とは異なる内部不整合です。アプリで free list を操作せず、再現コードとビルド条件を添えて報告してください。

The allocator could not find an adjacent free cell in its free list during coalescing. This is an internal invariant failure rather than normal allocation exhaustion. Report a reproducer and build configuration.

`AL01` は Rust の panic コードで、JS の `error.code` として返す契約ではありません。panic handler / panic hook はアプリが選びます。

`AL01` is a Rust panic code, not a promised JS `error.code`. The application owns its panic handler/hook.

## PN01

**Rust panic**

任意で導入した `taraba::panic::set_hook()` または `taraba::panic::handler(info)` が Rust の panic を通知しました。release の JS Error はコードと URL のみを持ち、debug は Rust 側で生成した詳細も読めます。instance は閉じられるため、再開には新しい host と instance が必要です。Rust の unwind / Drop は実行しません。

The opt-in Rust hook/handler reported a panic. Release errors contain a code and URL; diagnostic output can include Rust details. The instance is closed and must be replaced to restart. Rust does not unwind or run destructors.

allocator の `AL01` を含む panic も release では `PN01` にまとめます。通常の Wasm trap や外部例外をこのコードに変換するわけではありません。[導入と debug 設定 / Setup and diagnostic builds](panic-reporting.md)。

All reported panics, including an allocator `AL01`, use `PN01` in release. Native Wasm traps and foreign exceptions are not converted to this code.

## Rust panic / native errors

このページへリンクするのは taraba 自身の JS ランタイムエラーと、任意で有効にする `PN01` の panic 通知です。アプリや依存ライブラリの文字列をビルド時に一括削除・書き換えはしません。`std` をリンクした Wasm には `capacity overflow` など Rust 標準ライブラリの panic 文言・ソース位置が残る場合があります。taraba の JS 説明辞書とは別です。最小の `no_std` サンプルは `unreachable` の panic handler を使います。

Links are attached to taraba's own JS runtime errors and the opt-in `PN01` panic report. Application/dependency strings are not globally rewritten. Wasm linked with Rust `std` may retain standard panic text and source locations. This is separate from taraba's JS description dictionary. The minimal `no_std` example uses an `unreachable` panic handler.

## Retired codes / 廃止したコード

- `RT14`: bindings の runtime 型検査。現在は WIT・生成 TS 型の契約に従います。Binding types now follow WIT/generated TS.
- `RT15`: JSPI の存在検査。現在は対応済みエンジンを前提とします。JSPI-capable engines are assumed.

[Core API reference](core-runtime.md) · [Core API リファレンス](core-runtime.ja.md)

## RT13

**host disposed**

`host.dispose()` によりインスタンスが終了しました。再度の dispose は何もせず、新しい呼び出しや attach は拒否します。Future は poll 終了後に Drop し、subscription と JS root を解放します。`--abort-signal` のホスト I/O には abort を通知します。JSPI の停止スタックは元の I/O が完了するまで残りますが、呼び出し元の Promise は直ちに reject します。

The host was explicitly disposed. Disposal is idempotent; further calls and attachment are refused. Future tasks are dropped after active polling finishes, subscriptions and JS roots are released, and cooperating I/O in abort-enabled builds is aborted. JSPI caller Promises reject immediately; an already suspended stack remains engine-owned until its original I/O settles.

## RS01

**invalid resource lease**

解放済み、別型、または別 instance の resource lease です。The resource lease is disposed, has the wrong WIT resource type, or belongs to another instance.

## RS02

**resource ownership conflict**

Rust 所有中または borrow 中の resource を dispose / 移譲しようとしました。The resource is Rust-owned or borrowed and cannot be disposed or transferred now.

## RS03

**resource already owned**

同じホスト実装を重複して own として返しました。The same host implementation was returned as a new owner more than once.
