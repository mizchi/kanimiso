# Core API リファレンス

[English](core-runtime.md) | 日本語

インストール、WIT-first な Component、npm 生成の手順は[利用ガイド](guide.ja.md)にあります。ここでは **Core/JS の独自 ABI** の二構成を定義します。標準 Component はこの lowering を通さず、wit-bindgen/jco の契約を使います。

CLI の `taraba build` は、生成された Wasm のランタイム import/export と WIT resource から Core の方式を自動選択します。`--jspi` / `--future` で強制指定できます。これはビルド時の判定で、実行時のフォールバックではありません。

Core のビルドは SemVer と独立して、コンパイル済み Rust runtime の ABI を検査します。`export_runtime!()` が revision を埋め込み、欠落・不一致・重複・不正な revision は最適化や出力置き換えの前に拒否します。受理した revision は `build.json` に記録し、配布 Wasm の増分は 0 B です。古い raw 入力は、対応する runtime crate と CLI で再ビルドしてください。

## 実行契約

| 契約                                        | Core/JSPI                         | Core Future                                                           |
| ------------------------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| Rust の import                              | 同期形の関数を JSPI が suspend    | 生成された async import が `HostResult<T>` を返す                     |
| A が待機中の別の root 呼び出し              | instance ごとのキューで待つ       | 独立して進行できる                                                    |
| 任意の Pending Rust Future                  | executor なし                     | 小さい Future は slot 内、大きい Future は自動 Box 化で対応           |
| 明示的キャンセル                            | なし                              | JoinHandle.cancel / host.cancel / 任意の AbortSignal                  |
| host reject / Wasm trap                     | 最初の fatal で instance を閉じる | fatal trap は閉じる。Promise Err の伝播は個別 task の reject にできる |
| fatal な JS 例外経路の Rust Drop            | 保証しない                        | trap 後に Drop を再試行しない                                         |
| 標準 Canonical ABI                         | 未対応                            | 未対応。Component を使う                                              |
| record / string / list                      | 未対応                            | world・interface の型付き binding で対応                             |

JSPI の binding から同じ instance を await する再入はしないでください。外側の呼び出しは I/O 終了までキューを保持します。実行契約間の自動フォールバックはありません。

## WIT 境界

両方とも s32/u32/f64 と戻り値なしの関数に対応します。JSPI はこの scalar 境界に限定します。Future は imported resource の own/borrow と型付き async を扱います。interface の名前空間を維持し、別 interface の同名 method も利用できます。

Future の雛形は world 直下の型付き async 関数から始められます。名前付き interface にも対応します。[interface・resource の例](typescript.ja.md#interface-とリソースの寿命)を参照してください。

```wit
package example:app@0.1.0;
world app {
  import add: func(a: s32, b: s32) -> future<s32>;
  export run: func(a: s32, b: s32) -> future<s32>;
}
```

この Core 構成では `async func(a: s32, b: s32) -> s32` も同じ意味になります。world・interface の同期・非同期関数で数値、bool、char、string、list、option、result、tuple、record、variant、enum、flags と型エイリアスに対応します。imported opaque resource の own/borrow も型付き async と併用できます。resource の method、Rust が実装する exported resource、戻り値・入れ子の borrow、stream、入れ子の future、固定長 list は Core の対象外です。標準 resource binding は `--component` を使います。それ以外の型・提案への対応は upstream toolchain に従い、Core のテストでは確認していません。

生成された `build.rs` が `taraba bindgen` を実行し、Cargo の OUT_DIR に `bindings.rs` を作ります。これを include して `bindings!()` を呼び、生成された `Guest` trait を `HostResult<T>` を返す `async fn` で実装し、`export!(App)` を呼びます。import は安全な async 関数で、`?` は JS のエラー identity を維持して Promise の拒否を伝播します。[全体のサンプル](../README.ja.md#最小サンプル)。

WIT の宣言から、既存の Core Promise/resource ABI を隠す型付き API を生成します。標準 Canonical ABI の future handle や Component の async scheduler とは異なる契約です。生の handle の所有権移譲は生成コード内で扱います。公開 WIT のメタデータはビルド入力との一致を検査し、最適化前に削除するため、配布サイズにも JS にも追加しません。`taraba build` は同じ CLI のパスと選んだ WIT/world を build script に渡します。`cargo build` を直接使う場合は更新した CLI を PATH に置くか、実行ファイルを `TARABA_BINDGEN` に設定します。

従来の手動 resource binding も維持します。その resource は undefined 以外の JS 値で、handle は JS root です。Canonical resource table の handle ではありません。opaque Promise resource の payload は型不明のままです。

`resource value { constructor(...); }` を持つ interface を `io` として import すると、同期の型付き factory として Rust の `imports::io::value(...)`、JS の `bindings.io.value(...)` を生成します。返り値の owner は通常の resource 関数と同じ own/borrow/Drop の契約に従います。[constructor と寿命の例](typescript.ja.md#interface-とリソースの寿命)を参照してください。

## 型と必要な変換処理

共有 `runtime.mjs` に型ごとの実装は追加しません。WIT の関数シグネチャから到達できる型の Rust 変換関数を生成し、最適化後の Wasm が実際に import する変換だけを `index.js` に残します。encode / decode の片方向しか使わない場合も、不要な方向の JS は含みません。未使用の型宣言や未使用 import のための変換処理は配布物に入りません。

| WIT | Rust | JavaScript / TypeScript |
| --- | --- | --- |
| s8/s16/s32、u8/u16/u32、f32/f64 | 対応する整数・浮動小数型 | number |
| s64 / u64 | i64 / u64 | bigint |
| bool | bool | boolean |
| char | char | Unicode scalar 一文字の string |
| string | String | string |
| 数値の list<T> | Vec<T> | 対応する TypedArray（入力は readonly 配列も可） |
| その他の list<T> | Vec<T> | Array<T> |
| option<T> | Option<T> | T または undefined。入れ子の外側はタグ付き |
| result<T,E> | Result<T,E> | `{tag:"ok", val:T}` / `{tag:"err", val:E}`。unit の val は省略可能 |
| tuple<...> | tuple | tuple 配列 |
| record | 生成した struct | オブジェクト |
| variant | 生成した enum | `{tag:"case", val:...}` |
| enum | 生成した enum | ケース名の文字列 union |
| flags | bool フィールドを持つ生成 struct | boolean フィールドを持つオブジェクト |

JS のフィールド名・タグは WIT の綴りを維持します。Rust の型名・enum ケース名は PascalCase、フィールド名は snake_case です。文字列と list は Rust の所有する String / Vec にコピーします。JS の不正な孤立 surrogate は UTF-8 変換時に U+FFFD になります。TS の char は string なので、ホストは一つの Unicode scalar を渡してください。

WIT の名前付き型も TS に export します。`WitInput<T>` は readonly な入力、単純な option のフィールドは optional プロパティとして扱います。[TypeScript との疎通サンプル](typescript.ja.md)に生成型・バイト列・Result の使い方をまとめています。

たとえば、次の WIT でドメイン型を非同期に受け渡せます。

```wit
package example:messages;
world app {
  record message { text: string, ids: list<u64> }
  type response = result<message, string>;
  import enrich: func(value: message) -> future<response>;
  export run: async func(value: message) -> response;
}
```

```rust
include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
bindings!();
struct App;
impl Guest for App {
    async fn run(value: Message) -> HostResult<Response> {
        enrich(value).await
    }
}
export!(App);
```

host の `enrich` は Message に対応するオブジェクトを受け取り、`{tag:"ok", val: message}` または `{tag:"err", val: "理由"}` を返します。返した result はドメインの値です。Promise 自体の reject は外側の HostResult の Err になり、`?` で伝播すると export の Promise が同じ JS 例外で reject されます。

`just core-types-check` は std / no_std の実ビルド・往復変換・参照解放・strict TS・未使用型の増分 0 B を検証します。`just compare-core-types` は型ごとのサイズを `docs/core-types-size.json` に記録します。

同じ「host の echo を1回 await して返す」no_std 実装の比較です。wasm-opt / JS minify 後、圧縮前。JS は共有ランタイム 3,585 B を含みます。Wasm や Rust の割り当てを含む型変換の費用であり、共有ランタイム自体の増加ではありません。

<!-- core-types-size:begin -->
| WIT の値型 | Wasm | JS（共有分込み） | s32 比 Wasm 増分 | s32 比 JS 増分 |
| --- | ---: | ---: | ---: | ---: |
| `s32` | 1394 B | 3695 B | +0 B | +0 B |
| `bool` | 1461 B | 3751 B | +67 B | +56 B |
| `u64` | 1469 B | 3856 B | +75 B | +161 B |
| `string` | 2554 B | 4158 B | +1160 B | +463 B |
| `list<u8>` | 2554 B | 4079 B | +1160 B | +384 B |
<!-- core-types-size:end -->

## 生成する JavaScript API

| 出力                | API                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Core `pkg/index.js`  | `createHost({bindings})` → `host.imports` で標準 instantiation → `host.attach(instance.exports)`。呼び出しは、型のある `host.run(...)` |
| 両方                | `host.stats()` / `host.dispose()`                                                                                                      |
| Future のみ         | `host.activeTasks()` と `host.cancel(token)`                                                                                           |

host は同じ host.imports で生成した一つの instance に一度だけ attach します。attach 後は raw の instance.exports の関数を直接呼ばず、host の API を使います。JSPI は attach 前の呼び出しを reject し、再 attach や閉じた host への attach を拒否します。

`index.js` と共有 `runtime.mjs` は `createHost` だけを export します。アプリ用の factory が型付き WIT メソッドを公開します。Wasm のロードには標準の `WebAssembly.instantiate`、`instantiateStreaming`、`new WebAssembly.Instance` を使い、その exports を attach します。

生成したアプリのメソッドは、両構成とも Promise を返します。共有ランタイム内部の呼び出しは `call(name, ...args)` の一つに揃え、Future の戻り値は生成メソッドで Promise にします。host に `promise`、`root`、`get`、`take`、`release` の別名は持たせません。`imports.jsrt` は Future の Wasm import 接続用であり、root/table/task は生成した所有権の変換や Rust executor に必要です。アプリからは型付きメソッドだけを呼びます。キャンセル対象の token は明示的に選びます。activeTasks はリクエストと token の安定した対応表ではありません。

Core の両実行構成で、WIT から `AppBindings`、`AppExports`、`AppHostOptions`、`AppHost` を生成します。`AppHost` は `AppExports` を継承し、WIT の export を Promise を返すメソッドとして直接呼べます。host の予約名は `imports`、`attach`、`stats`、`cancel`、`activeTasks`、`dispose`、`then` です。重複する WIT export は改名するか Component を使います。アプリ固有の `index.js` は共有可能な `runtime.mjs` を import するため、集約対象は runtime だけにします。scalar は number、`future<s32>` / `future` の export は `Promise<number>` / `Promise<void>` です。import の callback は対応する値または PromiseLike を受け付けます。従来の opaque Promise resource は **unknown** のままです。TS の型は実行時の値検査にはなりません。標準 async ABI の相互運用には Component を使います。

両構成とも `host.dispose()` は冪等です。Future は task をキャンセルして Drop し、host の root・subscription を解放します。`--abort-signal` 使用時は協調する I/O にもキャンセルを伝えます。JSPI は呼び出し元を直ちに reject しますが、停止中の stack は元の I/O が完了するまでエンジンが保持します。Rust Drop や I/O abort は強制しません。[終了処理と呼び出し単位のキャンセル](typescript.ja.md)を参照してください。

## Rust Future crate

| API                         | 契約                                                     |
| --------------------------- | -------------------------------------------------------- |
| `JsPromise.await`           | `Result<JsValue, JsValue>` を返す                        |
| `future_to_promise(future)` | 出力が `Result<JsValue, JsValue>` の static Future       |
| `spawn_local(future)`       | 出力 `()` の static Future。JoinHandle を返す            |
| `JoinHandle.cancel()`       | 生存中 task と subscription を明示的に Drop              |
| JoinHandle の Drop          | task を detach                                           |
| `JoinHandle.into_promise()` | 完了 Promise を移譲                                      |
| JsValue の Clone / Drop     | host root を retain/release。JS オブジェクトを複製しない |

allocator と no_std の panic handler はアプリが選びます。既定の静的 task 領域は **1,024 × 128 B**（`--task-slots` で変更可）、header・ID・Future 込みで、alignment は64以下です。header 込みで128 B または alignment 64を超える Future は自動的に Box へ pin し、pool にはそのポインタを置きます。型ごとの定数分岐なので、小さい Future は従来の領域を使い、fallback のアロケーション処理もリンクしません。同時タスク数は設定したスロット数までで、pool 枯渇・ヒープ OOM は fatal です。Vec/Box 用 allocator は、この slot とは別です。JsValue / JsPromise は一つの JS agent と instance に限定します。共有メモリは Core のビルド時に拒否します。関数名・シグネチャ・bindings は WIT と生成 TS 型を契約とし、ランタイムでは型の再検証や SharedArrayBuffer の存在確認をしません。JSPI の接続対象は生成 API から渡します。attach/fatal 状態と Future の所有権・タスク状態の不変条件は実行時に検査します。

生成 binding も Future の状態サイズに含まれます。自動 Box 化は std と no_std + alloc の両方で動き、アプリ側の allocator を使います。非常に大きな値を構築する際のスタック使用量は、必要に応じて明示的なヒープ構築で抑えます。

`JsFuture` の所有スロットは一つで、待機中は Promise、完了後は結果を保持します。完了時は Promise の root を解放してから、最後に登録した Waker を起こします。結果を取り出すと、その所有権を呼び出し側へ移します。subscription ID、外部 executor の Waker、キャンセル・Drop の保証は維持します。

`export_runtime!()` は private runtime export を一度定義します。生成した `export!(App)` がこれを呼び、所有権変換を供給します。利用コードから poll/drop/settle を呼んだり、生の handle を作ったりしないでください。

## エラー・機能・検証

Rust の panic を簡易な JS Error にするには、std は `taraba::panic::set_hook()`、no_std はアプリの handler から `taraba::panic::handler(info)` を使います。release は `PN01` と URL のみを通知します。[導入・debug の設定・サイズ上の限界](panic-reporting.md)。

Core の `--debug` は説明付きエラー、release は RT code と[エラーの説明ページ](error-codes.md)へのリンクを出力し、説明辞書は同梱しません。fatal は最初の理由を保って JS roots を解放します。キャンセルは任意の host network I/O の中止を意味しません。遅れて解決した subscription は無効化済み ID で処理します。Drop 中の trap でも instance を閉じ、Drop を再試行しません。

実行環境は Safari 27+ / JSPI 対応 V8 です。機能検出を挟まず、JSPI の組み込み API を直接呼びます。Safari 実機は未検証です。GC/js-string/exnref/funcref の機能検証と、通常ランタイムが全機能を使うことは区別します。

[検証手順](development.ja.md)、[現在のサイズ比較](async-size.ja.md)、[採用条件](jspi-adoption.md)。Kani は native64 の限定したモデル・部品の検証で、JS エンジン・生成 Wasm・ABI 全体の証明ではありません。

[Interface・resource・終了処理・pool 設定](typescript.ja.md#interface-とリソースの寿命)。

文字列は生成した TextEncoder import が出力する UTF-8 を使い、Rust 側の重複した UTF-8 検査を省きます。生成した private codec の置換は契約外です。非共有メモリとゼロ初期化済みの専用 Vec にコピーし、不正な UTF-16 は TextEncoder の置換規則に従います。[変更前後のサイズ](bundle-tuning.ja.md)。
