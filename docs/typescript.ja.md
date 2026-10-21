# TypeScript と Rust をつなぐ

[English](typescript.md) | 日本語

WIT をインターフェースの定義元にし、Rust の async API と npm パッケージの型定義を生成します。CLI と Rust crate は 0.2.0 以降を使います。[インストール手順](guide.ja.md#インストール)を参照してください。

```sh
taraba new interop --future --no-std
cd interop
# wit/app.wit と src/lib.rs を編集
taraba build
```

## WIT から両側の型を生成する

`wit/app.wit`:

```wit
package example:interop;
world app {
  record request { id: u64, payload: list<u8>, label: option<string> }
  record reply { accepted: u32 }
  variant failure { invalid-input(string), unavailable }
  type response = result<reply, failure>;
  import send: func(value: request) -> future<response>;
  export run: async func(value: request) -> response;
}
```

`src/lib.rs` の allocator と panic handler は雛形のまま、binding 以下を置き換えます。

```rust
include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
bindings!();
struct App;
impl Guest for App {
    async fn run(value: Request) -> HostResult<Response> {
        send(value).await
    }
}
export!(App);
```

TS では `pkg/index.js` から実装と型を import します。型名は WIT の名前を PascalCase にしたものです。`import type` は JS に残りません。

```ts
import { createHost } from './pkg/index.js';
import type { AppBindings, Request, Response } from './pkg/index.js';

const bindings = {
  async send(request: Request): Promise<Response> {
    if (request.payload.length === 0) {
      return { tag: 'err', val: { tag: 'invalid-input', val: 'empty payload' } };
    }
    return { tag: 'ok', val: { accepted: request.payload.length } };
  },
} satisfies AppBindings;

export async function example(bytes: BufferSource): Promise<Response> {
  const host = createHost({ bindings });
  const { instance } = await WebAssembly.instantiate(bytes, host.imports);
  host.attach(instance.exports);

  const response = await host.run({ id: 1n, payload: [1, 2, 3] as const });
  if (response.tag === 'err' && response.val.tag === 'invalid-input') {
    console.error(response.val.val);
  }
  return response;
}
```

ブラウザーなら `example(await (await fetch('./pkg/app.wasm')).arrayBuffer())` として呼べます。公開する場合は `pkg/` をそのまま npm パッケージにできます。`index.d.ts` と package exports の設定も生成済みです。

## 入力と出力の規約

| WIT | TS で渡せる値 | Rust から受け取る値 |
| --- | --- | --- |
| `string` / `bool` | string / boolean | 同じ型 |
| 32bit 以下の整数、f32/f64 | number | number |
| `s64` / `u64` | bigint | bigint |
| `list<u8>` | Uint8Array、readonly number[] | Uint8Array |
| 他の数値 list | 対応する TypedArray、readonly number[] / bigint[] | 対応する TypedArray |
| その他の list / tuple / record | readonly な配列・tuple・オブジェクトも可 | 生成した通常の可変型 |
| `option<T>` | T または undefined | T または undefined |
| record の単純な option フィールド | 省略可。明示的な undefined も可 | optional プロパティ |
| `option<option<T>>` | 外側は `{tag:"none"}` / `{tag:"some", val:T \| undefined}` | 同じ表現 |
| `result<T,E>` | `{tag:"ok", val:T}` / `{tag:"err", val:E}` | 同じ discriminated union |

WIT の名前付き型は `Request`、`Response` などとして export します。JS から Rust に渡せる形は `WitInput<Request>` で参照でき、readonly を再帰的に受け付けます。末尾の単純な option 引数は省略できます。入れ子の option は外側のタグを維持し、None と Some(None) を区別します。

数値 list は Uint8Array / Int8Array / Uint16Array / Int16Array / Uint32Array / Int32Array / BigUint64Array / BigInt64Array / Float32Array / Float64Array に対応します。入力を変更せずに Rust の Vec へコピーし、出力も Wasm メモリから独立したバッファへコピーします。subarray の offset を扱え、出力は後の memory.grow でも有効です。所有権を貸し出す zero-copy API ではありません。

WIT の関数名・フィールド名・タグの綴りは維持します。ハイフンのある名前は `host['process-order']` のように参照します。数値の範囲、char が Unicode scalar 一文字であることはホストの契約です。生成 TS 型は実行時の検証を追加しません。WitInput、Promise、Uint8Array など、生成 API や TS 基盤型と衝突する型名はビルド時に拒否します。

## エラーと非同期

WIT の result の err はドメインの値で、Promise は成功して union を返します。型付きのエラーを呼び出し側で分岐したい場合はこちらを使います。ホストの throw / Promise reject は Rust の外側の HostResult の Err になり、`?` で伝播すると export の Promise が同じ JS 例外で reject されます。

ホストの async import は同期の値、Promise、PromiseLike を返せます。`satisfies AppBindings` で引数と結果を検査します。catch で受け取る値は TS の通常の unknown です。throw の型を Result の E と同一視しません。

JSON を扱う場合、bigint と TypedArray は JSON の配列・数値と同じ表現にはなりません。JSON 境界では文字列の ID や通常の配列へ明示的に変換してください。URL / Date / HTTP オブジェクトも WIT の文字列・数値・record へ分解します。標準 Component の相互運用や resource の method / stream が必要な場合は [Component 構成](guide.ja.md)を使います。

## 配布サイズと検証

名前付き型と WitInput は `.d.ts` にだけ存在します。型別の共有 JS ランタイムは追加せず、最適化済み Wasm に残った変換 import だけをアプリの `index.js` に含めます。未使用型・import の追加による Wasm / JS の増分 0 B を検証しています。[型ごとのサイズ表](core-runtime.ja.md#型と必要な変換処理)。

`just core-types-check` は std / no_std、strict・exactOptionalPropertyTypes・noUncheckedIndexedAccess・verbatimModuleSyntax、数値配列の端の値・NaN・負のゼロ、subarray・memory.grow、readonly・PromiseLike、拒否・キャンセルを検証します。このページの日英サンプルも実ビルド・実行し、npm pack / install 後に NodeNext と bundler の型解決を確認します。Safari 実ブラウザーは未検証です。

## 呼び出し単位のキャンセル

Core Future アプリを `taraba build --abort-signal` でビルドします。生成 export の末尾に `options?: CallOptions`、import callback の末尾に signal を持つ `context: HostContext` が付きます。

```ts
import { createHost, type AppBindings } from './pkg/index.js';

const bindings = {
  async send(request, { signal }) {
    await fetch('/api/check', { method: 'POST', signal });
    return { tag: 'ok', val: { accepted: request.payload.length } };
  },
} satisfies AppBindings;
const host = createHost({ bindings });
const bytes = await (await fetch('./pkg/app.wasm')).arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, host.imports);
host.attach(instance.exports);
const controller = new AbortController();
const pending = host.run({ id: 1n, payload: [1, 2, 3] }, { signal: controller.signal });
controller.abort();
await pending; // rejects with controller.signal.reason
```

abort すると、その呼び出しに属する Rust タスクと生存中の子タスクを Drop し、subscription を解除して、ホスト I/O の共通 signal も abort します。同じ instance の他の呼び出しは継続します。事前に abort 済みなら Wasm に入りません。poll 中なら戻るまでそのタスクの Drop を待ちます。遅れて届く Promise の結果は無視し、instance は再利用できます。ホスト側は context.signal を fetch などのキャンセル対応 API に渡してください。任意の Promise の処理をランタイムだけで止めることはできません。

export の Promise が完了すると、外部 signal の listener を解除します。完了後も detach して残る子タスクは、その外部 signal には追従しません。このオプションを有効にしたビルドでは、明示的なタスクキャンセルも呼び出し全体の scope を abort します。fatal trap では未完了 I/O を abort し、instance を閉じます。

WIT の引数位置は変えません。末尾の option 引数を省略して options を渡す場合は、その位置に `undefined` を渡します。AbortSignal / HostContext は JS facade の型で、WIT の payload には含めません。JSPI / Component ビルドではこのオプションを拒否します。watch と `taraba update` も設定を引き継ぎます。

| Core Future のビルド | 共有 JS ランタイム | キャンセル対応による Wasm 増分 |
|---|---:|---:|
| 既定 | 3,585 B | 0 B |
| --abort-signal | 4,414 B | 0 B |

この共有アセットに加えて、アプリごとの呼び出しラッパーの JS が少量増えます。

フラグなしではキャンセル用ラッパーも context も生成せず、共有ランタイムは3,585 Bです。有効時のサイズと Wasm 増分0 Bは `just task-features-check` で確認します。実際の HTTP fetch の中断、並行呼び出しの分離、大きな Future の Drop、strict TS も検証します。標準 wit-bindgen とのサイズ・速度・メモリ比較は[複合型の計測](rich-async-size.ja.md)を参照してください。

## Interface とリソースの寿命

WIT の interface alias は名前空間になります。`import io: source` は Rust の `imports::io::run` と TS の `bindings.io.run`、`export api: source` は `exports::api::Guest` と `host.api.run` を生成します。別の interface に同名の method を定義できます。interface の型名には `SourcePacket` のように接頭辞が付きます。

import した opaque resource は、通常の関数の `own<value>` と直接の `borrow<value>` 引数として async と併用できます。Rust の owner は RAII で解放し、export の borrow 引数は `Borrowed<HandlesValue>`、import の borrow 引数は `&HandlesValue` になります。JS ホストは `Disposable` な実装を提供し、公開 API は opaque な lease を返します。

```ts
class Value {
  constructor(public text: string) {}
  [Symbol.dispose]() { /* ホスト側のリソースを解放 */ }
}
type Resources = { HandlesValue: Value };
const host = createHost<Resources>({ bindings: {
  io: { value: (text: string) => new Value(text), read: async (value: Value) => value.text },
}});
// 上の例と同様に instantiate / attach する。
const value = await host.make();
await host.inspect(value); // borrow。呼び出し元が lease を所有したまま
value[Symbol.dispose]();
host.dispose();
```

この例の WIT は `interface handles { resource value { constructor(text:string); } read: async func(v:borrow<value>)->string; }` を `io` として import し、world 直下に `make` / `inspect` を export する構成です。WIT constructor は Rust の `imports::io::value(text)`（戻り値 `HandlesValue`）と、同期 JS factory `bindings.io.value(text)` を生成します。interface alias ごとに factory は独立します。class は必須ではなく、対応する Disposable な実装を callback から返せます。他の binding と constructor 名が衝突する場合はビルドエラーにします。

lease は own で移譲するか明示的に dispose します。borrow 中の dispose と他 instance の lease の使用は拒否します。キャンセルした borrow は実行中の poll が戻ってから終了し、host 終了時には Rust 所有のリソースを解放します。JS が所有する lease は呼び出し元が解放してください。ホスト処理はキャンセル通知後に借用オブジェクトへアクセスしないでください。

resource の method、Rust が実装する exported resource、戻り値や入れ子の borrow は Core の対象外です。標準の resource 契約には Component を使います。`just interfaces-check` / `just resources-check` は std / no_std、strict TS、constructor、キャンセル、他 instance の handle、Drop を確認します。未使用 constructor の配布 Wasm/JS の増分は 0 B です。

## Host の終了とタスク容量

instance を使い終えたら `host.dispose()` を呼びます。複数回呼んでも安全です。Future のタスクをキャンセルして Drop し、subscription と JS root を解放し、abort 対応の I/O を中断します。poll 内で呼んだ場合は poll が戻るまで Drop を待ちます。以後の呼び出しは `RT13` で reject します。JSPI でも呼び出し元の Promise は直ちに reject しますが、停止中の Wasm stack は元のホスト I/O が完了するまでエンジンに残ります。

`taraba build --task-slots 16` は Core Future の静的 pool を16スロットにしてコンパイルします。既定は1,024スロット、1スロット128 Bで、上限を超えると fatal OOM になります。大きな Future はヒープに pin しますが、消費するスロットは1つです。JS 上の制限値だけでなく静的領域を変更します。生の Wasm を入力する場合は、コンパイル済み容量と一致する値が必要です。watch と `taraba update` は設定を引き継ぎます。Rust runtime 0.2.0 以降が必要です。
