# Expose stateful Rust resources through WIT

English | [日本語](resources.ja.md)

Core Future can keep Parser, Validator or session state in Rust and expose typed JS objects from WIT. Available in 0.2.1: update both the CLI and Rust runtime to 0.2.1 or later. Use `--component` for standard Component ABI interoperability.

Start with `taraba new counter --future --no-std` and replace `wit/app.wit`:

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

Keep the scaffold allocator and panic handler in `src/lib.rs`, replacing its bindings and implementation below. App and the implementation type must be public. `bindings!(App)` resolves resource associated types.

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

Run `taraba build`. Instantiate and attach as usual, then call the object methods. Even synchronous WIT methods return Promises through the JS facade.

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

## Ownership and shutdown

`own<counter>` transfers ownership and invalidates the original JS lease. `borrow<counter>` and method receivers remain borrowed through completion or cancellation; disposal or ownership transfer during a borrow is rejected with `RS02`. A wrong resource type or instance is `RS01`. Invalid leases detected by a codec inside Wasm close the instance; create a new host to recover.

Methods take `&self`. Use Cell / RefCell for mutation, and do not hold a RefMut across an await. Async methods may progress concurrently. Awaiting reentry into the same instance is supported by Future; this differs from JSPI serialization.

Normally, an owner's `Symbol.dispose` or `host.dispose()` runs Rust Drop. Shutdown waits for active polling, drops borrowed Futures and resource-held JS roots before closing the runtime. Late Promise settlements are ignored. Panic/trap does not unwind or guarantee Rust Drop, and destructors never reenter poisoned Wasm.

## Imported resources and limits

JS-defined resource instance methods also work. WIT `resource value { constructor(text:string); read:async func()->string; }` generates Rust `imports::io::value(text)` and `value.read().await`. JS bindings.io.value returns a Disposable object implementing read. Its receiver is preserved; no separate read callback is required.

Core Rust resources currently require one export alias. Static methods, returned/nested borrows, Rust resources passed to host imports, and streams are unsupported. A method named then is rejected at build time to avoid Promise thenable assimilation. Use Component for standard Canonical ABI interoperability.

## Size and verification

A library containing only synchronous resource methods emits no Rust task exports such as rt_poll. Type-specific codecs and resource management enter the application's index.js; the shared runtime.mjs is unchanged. `just core-types-check` verifies +0 B deployed Wasm and minified JS for unused imported methods and exported resource type declarations. Exporting constructors or methods retains their public API and implementation bytes.

`just resources-check` covers std/no_std, constructors, state changes, async borrows, own transfer, type/instance identity, cancellation, shutdown during poll, traps, Drop ordering, npm pack/install and strict NodeNext/bundler TS. `just browser-check` runs Chrome and Playwright WebKit; WebKit E2E is the accepted completion criterion for Safari validation. Miri and bounded native64 Kani checks cover Rust storage lifetime and generation logic, not the whole JS/Wasm implementation.
