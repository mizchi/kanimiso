# WIT から状態付き Rust resource を公開する

[English](resources.md) | 日本語

Core Future では、Parser・Validator・セッションなどの状態を Rust に置き、WIT から型付き JS オブジェクトを公開できます。この機能は 0.2.1 で利用できます。CLI と Rust runtime の両方を 0.2.1 以降に更新してください。標準 Component ABI を使う場合は `--component` を選びます。

`taraba new counter --future --no-std` で作り、`wit/app.wit` を次に置き換えます。

```wit
package example:counter;
interface counters {
  resource counter {
    constructor(start: u32);
    add: func(value: u32) -> u32;
    read: func() -> u32;
    wait: async func() -> u32;
  }
  consume: func(value: own<counter>) -> u32;
}
world app {
  import tick: async func();
  export api: counters;
}
```

`src/lib.rs` の allocator・panic handler 等は雛形のまま残し、bindings と実装を次に置き換えます。`App` と実装型は公開型にします。`bindings!(App)` が resource の関連型を解決します。

```rust
include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
bindings!(App);
use core::cell::Cell;

pub struct App;
pub struct Counter(Cell<u32>);
impl exports::api::Guest for App {
    type Counter = Counter;
    fn consume(value: CountersCounter) -> u32 { value.0.get() }
}
impl exports::api::GuestCounter for Counter {
    fn new(start: u32) -> Self { Self(Cell::new(start)) }
    fn add(&self, value: u32) -> u32 {
        let next = self.0.get().wrapping_add(value);
        self.0.set(next);
        next
    }
    fn read(&self) -> u32 { self.0.get() }
    async fn wait(&self) -> HostResult<u32> {
        tick().await?;
        Ok(self.0.get())
    }
}
export!(App);
```

`taraba build` で生成します。JS は通常どおり instantiate → attach し、オブジェクトの method を呼びます。同期の WIT method も JS facade では Promise を返します。

```ts
import { createHost } from './pkg/index.js';
const host = createHost({ bindings: { tick: async () => {} } });
const bytes = await (await fetch('./pkg/app.wasm')).arrayBuffer();
host.attach((await WebAssembly.instantiate(bytes, host.imports)).instance.exports);
const counter = await host.api.counter(7);
await counter.add(2); // 9
await counter.wait(); // 9
await host.api.consume(counter); // transfers ownership, returns 9
counter[Symbol.dispose](); // already consumed: no-op
host.dispose();
```

## 所有権と終了処理

`own<counter>` は所有権を移譲し、元の JS lease を無効にします。`borrow<counter>` と method の receiver は呼び出し完了・キャンセルまで借用を保ち、その間の dispose や own 移譲は `RS02` で拒否します。resource の型・instance が異なる場合は `RS01` です。Wasm 内の codec で不正な lease を検出した場合は instance を閉じるため、新しい host が必要です。

method は `&self` です。変更には `Cell` / `RefCell` などを使い、`RefMut` を非同期の待機中に保持しないでください。複数の async method は同時に進行します。同じ instance への再入を await できるのは Future 構成で、JSPI の直列化とは別です。

通常は JS owner の `Symbol.dispose` または `host.dispose()` で Rust の Drop を実行します。終了時には借用中の Future を poll 後に Drop し、resource の JS root を解放してから runtime を閉じます。遅れて届いた Promise の完了は無視します。panic/trap は unwind しないため Rust Drop を保証せず、poison 済み Wasm の destructor を再び呼びません。

## imported resource と対応範囲

JS 実装の resource も instance method に対応します。WIT の `resource value { constructor(text:string); read:async func()->string; }` は Rust の `imports::io::value(text)` と `value.read().await` を生成します。JS は `bindings.io.value` から Disposable で `read` を持つオブジェクトを返します。`this` は保たれ、別の read callback は不要です。

Core の Rust resource は1つの export alias に対応します。static method、戻り値・入れ子の borrow、Rust resource を host import に渡す構成、stream は未対応です。`then` という method は Promise の thenable と衝突するためビルド時に拒否します。標準 Canonical ABI との相互運用は Component を使います。

## サイズと検証

同期 method だけの resource は Rust の `rt_poll` 等の task export を含めません。型別の codec と resource 管理はアプリの `index.js` に生成し、共有 `runtime.mjs` は増やしません。未使用の imported method と exported resource 型宣言は、Wasm・minify 後 JS とも増分 0 B を `just core-types-check` で確認します。constructor や method を export すれば公開 API として残るため、その実装分はサイズに含まれます。

`just resources-check` は std/no_std、constructor、状態変更、非同期借用、own 移譲、型・instance、キャンセル、poll 中の終了、trap、Drop の順序と npm pack/install・NodeNext/bundler strict TS を確認します。`just browser-check` は Chrome と Playwright WebKit を実行します。Safari 向け検証は WebKit E2E で完了とします。Miri と限定した native64 Kani 検証は Rust storage の寿命と世代番号を扱い、JS/Wasm 全体の証明ではありません。
