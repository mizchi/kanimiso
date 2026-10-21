# Connect TypeScript and Rust

English | [日本語](typescript.ja.md)

Use WIT as the interface definition and generate both Rust async bindings and npm type declarations. Use CLI and Rust crates 0.2.0 or later; see [installation](guide.md#installation).

```sh
taraba new interop --future --no-std
cd interop
# Edit wit/app.wit and src/lib.rs
taraba build
```

## Generate both sides from WIT

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

Keep the scaffold's allocator and panic handler; replace the bindings and application implementation in `src/lib.rs`:

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

Import implementation and types from `pkg/index.js`. WIT type names become PascalCase exports; `import type` adds no JavaScript.

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

In a browser, call `example(await (await fetch('./pkg/app.wasm')).arrayBuffer())`. The generated `pkg/` is an npm package with `index.d.ts` and package exports already configured.

## Input and output conventions

| WIT | Accepted TS inputs | Values returned by Rust |
| --- | --- | --- |
| `string` / `bool` | string / boolean | same type |
| Integers up to 32 bits, f32/f64 | number | number |
| `s64` / `u64` | bigint | bigint |
| `list<u8>` | Uint8Array or readonly number[] | Uint8Array |
| Other numeric lists | matching TypedArray or readonly number[] / bigint[] | matching TypedArray |
| Other lists / tuples / records | readonly arrays, tuples and objects accepted | ordinary mutable generated types |
| `option<T>` | T or undefined | T or undefined |
| Record fields with a simple option type | may be omitted or explicitly undefined | optional property |
| `option<option<T>>` | outer `{tag:"none"}` / `{tag:"some", val:T \| undefined}` | same representation |
| `result<T,E>` | `{tag:"ok", val:T}` / `{tag:"err", val:E}` | same discriminated union |

Named WIT types are exported as Request, Response and so on. Use `WitInput<Request>` to refer to the accepted input shape, including recursive readonly containers. Trailing simple option arguments may be omitted. Nested options keep their outer tag so None and Some(None) remain distinct.

Numeric lists map to Uint8Array / Int8Array / Uint16Array / Int16Array / Uint32Array / Int32Array / BigUint64Array / BigInt64Array / Float32Array / Float64Array. Inputs are copied into owned Rust Vec values without mutation. Outputs are copied into independent JS buffers: subarray offsets work, and later memory.grow does not invalidate returned arrays. These bindings do not lend linear-memory views.

Function names, fields and tags retain WIT spelling. Access hyphenated names as `host['process-order']`. The host must respect numeric ranges and supply one Unicode scalar for char. Generated TS types add no runtime validation. Type names that collide with generated APIs or required TS builtins, such as WitInput, Promise and Uint8Array, are rejected at build time.

## Errors and async callbacks

A WIT result err is a domain value: its Promise resolves with a discriminated union. Use it when callers should branch on a typed error. A host throw or Promise rejection instead becomes the outer Rust HostResult error; propagating it with `?` rejects the exported Promise with the same JS exception.

Host async imports can return a synchronous value, Promise or PromiseLike. Check callbacks with `satisfies AppBindings`. Catch variables remain ordinary TypeScript unknown; thrown exceptions are separate from the result's E type.

JSON does not represent bigint or TypedArray values as ordinary JSON numbers and arrays. Convert IDs to strings and typed arrays to ordinary arrays explicitly at a JSON boundary. Represent URL, Date and HTTP objects with WIT strings, numbers and records. Use [Component output](guide.md) for standard Component interoperability or streams.

## Deployment size and verification

Named types and WitInput exist only in `.d.ts`. The shared JS runtime gains no type-specific code; application `index.js` contains only codec imports retained by optimized Wasm. Unused types and imports add zero deployed Wasm / JS bytes. See the [per-type size table](core-runtime.md#value-types-and-selective-code-generation).

`just core-types-check` covers std / no_std, strict / exactOptionalPropertyTypes / noUncheckedIndexedAccess / verbatimModuleSyntax, numeric boundaries, NaN and negative zero, subarray and memory.grow, readonly data and PromiseLike, rejection and cancellation. It also builds and runs the matching English/Japanese examples on this page, then verifies npm pack/install with NodeNext and bundler type resolution. Safari-target validation follows the [accepted WebKit E2E policy](browser-testing.md).

## Per-call cancellation

Build the Core Future application with `taraba build --abort-signal`. Each generated export accepts a final `options?: CallOptions`, and each import callback receives a final `context: HostContext` containing a signal:

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

Aborting drops the matching Rust task and its still-live spawned tasks, retires subscriptions and aborts the shared host I/O signal. Independent calls on the same instance keep running. Pre-aborted signals never enter Wasm. Cancellation during poll waits for poll to return before dropping that task. Late Promise settlements are ignored, and the instance can be reused. Host code must pass the context's signal to fetch or another cancellable API; arbitrary Promises cannot be stopped by the runtime.

The external signal listener is removed when the exported Promise settles. Detached child tasks that outlive a completed call no longer follow that external signal. In this opt-in build, explicit task cancellation also aborts its call's scope. Fatal traps abort outstanding I/O and close the instance.

The WIT arguments keep their positions: when an optional final argument is omitted, pass `undefined` before the options object. AbortSignal and HostContext belong to the JS facade, not to the WIT payload. JSPI and Component builds reject this option. `taraba update` and watch rebuilds retain it.

| Core Future build | Shared JS runtime | Wasm increase from cancellation |
|---|---:|---:|
| Default | 3,585 B | 0 B |
| --abort-signal | 4,414 B | 0 B |

The per-application method wrapper adds a small amount of JS in addition to this shared asset.

Without the flag, no cancellation wrapper or context is generated: shared runtime remains 3,585 B. The enabled shared runtime size and zero Wasm increase are checked by `just task-features-check`, including real HTTP fetch cancellation, concurrent isolation, large Future Drop and strict TS. See [the rich workload comparison](rich-async-size.md) for size, timing and memory against standard wit-bindgen.

## Interfaces and resource lifetimes

WIT interface aliases become namespaces: `import io: source` generates Rust `imports::io::run` and TS `bindings.io.run`; `export api: source` generates `exports::api::Guest` and `host.api.run`. Separate interfaces may use the same method name. Interface-owned types receive a prefix, such as `SourcePacket`.

Imported opaque resources support freestanding functions with `own<value>` and direct `borrow<value>` arguments, including async calls. Rust uses RAII owners and `Borrowed<HandlesValue>` for exported borrow parameters; an imported borrow callback takes `&HandlesValue`. The JS host supplies a `Disposable` implementation, while the public API returns an opaque lease:

```ts
class Value {
  constructor(public text: string) {}
  [Symbol.dispose]() { /* release the host resource */ }
}
type Resources = { HandlesValue: Value };
const host = createHost<Resources>({ bindings: {
  io: { value: (text: string) => new Value(text), read: async (value: Value) => value.text },
}});
// Instantiate and attach as above.
const value = await host.make();
await host.inspect(value); // borrow; the JS lease remains owned by this caller
value[Symbol.dispose]();
host.dispose();
```

These names correspond to `interface handles { resource value { constructor(text:string); } read: async func(v:borrow<value>)->string; }`, imported as `io`, with root `make` and `inspect` exports. The WIT constructor generates Rust `imports::io::value(text)` returning `HandlesValue` and a synchronous JS `bindings.io.value(text)` factory. Each interface alias has its own factory. A class is optional: the callback may return any matching Disposable implementation. Constructor names that collide with another binding are rejected.

Pass ownership with `own` or dispose the lease explicitly. Disposal during a live borrow and use through another instance are rejected. Cancelled borrows end after the active poll; Rust-owned resources are released on host shutdown. JS-owned leases remain the caller's responsibility. Do not access a borrowed host object after its cancellation signal fires.

Imported instance methods generate Rust calls such as `value.read().await`, and call the actual JS object method with its receiver preserved. They are part of the resource implementation type, not separate `AppBindings` callbacks.

Core Future also supports [Rust-defined exported resources](resources.md), including constructors, synchronous/asynchronous methods and own/borrow. Returned/nested borrows, static methods and Rust resources passed to host imports remain outside Core. Standard resource ABI interoperability requires Component. `just resources-check` covers std/no_std, strict TS, npm pack/install, cancellation, type/instance identity, shutdown and Drop. Unused imported methods and exported resource type declarations add 0 B to deployed Wasm/JS.

## Host shutdown and task capacity

Call `host.dispose()` when an instance is no longer needed. It is idempotent. Future tasks are cancelled and dropped, subscriptions and JS roots are cleared, and abort-enabled I/O receives cancellation. Disposal inside a poll waits until the poll returns. New calls reject with `RT13`. For JSPI, caller Promises reject immediately, but a suspended Wasm stack remains engine-owned until its original host I/O settles.

`taraba build --task-slots 16` compiles a Core Future pool with 16 slots (default 1,024). Each slot reserves 128 B; overflow is fatal OOM. A larger Future uses a pinned heap allocation without consuming extra slots. This option changes static storage, not merely a JS limit. Raw-Wasm builds must match the capacity already compiled into the runtime. `taraba update` and watch preserve the setting. The option requires Rust runtime 0.2.0 or later.
