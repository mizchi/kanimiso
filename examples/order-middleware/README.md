# Rust order middleware

English | [日本語](README.ja.md)

A small Request → order validation/quote → Response library. JS owns HTTP, WHATWG URL and JSON. Rust trims/normalizes customer and SKU values, merges duplicate SKUs, validates quantities/prices, checks u32 totals and awaits an injected authorization policy. It does not persist orders.

From a checkout with `just setup` completed:

```sh
just build-order-middleware
node examples/order-middleware/demo.mjs
pnpm --dir examples/order-middleware/pkg pack
```

For an installed CLI, from this example's directory with Binaryen 133 on PATH:

```sh
taraba build --world app
node package.mjs
node demo.mjs
```

The example's Cargo path dependencies select the matching checkout libraries. npm consumers only install the generated `pkg/` package; no Rust toolchain or repository is needed.

## Consume the generated npm package

```ts
import { createHost } from 'taraba-order-middleware';
import { createMiddleware } from 'taraba-order-middleware/http';

const host = createHost({ bindings: {
  authorize: async (tenant, total) => tenant === 'shop' && total <= 1_000_000,
}});
const { instance } = await WebAssembly.instantiate(bytes, host.imports);
host.attach(instance.exports);
const handle: (request: Request) => Promise<Response> = createMiddleware(host);
const response = await handle(request);
// When the host is no longer needed:
host.dispose();
```

`bytes` and `request` are supplied by the application. `createMiddleware` is an HTTP adapter and does not load or instantiate Wasm. Browser applications can use fetch/instantiateStreaming; Node can read the exported `taraba-order-middleware/app.wasm` asset. `.d.ts` types come from WIT; the HTTP declaration refers to the generated host type instead of duplicating domain types. The `./http` entry is added by this example's post-build `package.mjs`, not by changing taraba's public Core exports.

## Contract

- `POST /orders`, `application/json` (optional charset), `?dry-run=0|1`, `x-tenant` header.
- JSON: `{customer: string, items: [{sku: string, quantity: number, unitPrice: number}]}`. Unknown fields are ignored. Structural types/u32 ranges are checked before WIT conversion. Customer strings use Unicode scalar values; lone UTF-16 surrogates are replaced before entering either backend.
- Read at most 64 KiB of body bytes; cancel the source when exceeded. JSON is decoded as strict UTF-8. Reads can still encounter a large single upstream chunk; the limit bounds retained chunks, not the upstream producer's allocations.
- Tenant/SKU: ASCII alphanumeric, hyphen or underscore, 1–32 bytes. ASCII space/tab/CR/LF are trimmed. SKU is uppercased. Customer: 1–80 UTF-8 bytes after the same trimming.
- 1–128 lines, quantity 1–100, integer price 1–1,000,000 minor currency units. Duplicate normalized SKUs merge in first-occurrence order; different prices or combined quantity >100 fail. Checked total must fit u32. A bounded linear search avoids a hash-map dependency.
- Authorization is called once after successful validation, including dry runs. This example's policy is illustrative; applications supply their own I/O and authorization rules.
- Protocol/structural failures: 400/404/405/413/415. Domain failures: 422. Denied authorization: 403. Successful receipts: 200. Unexpected host I/O errors propagate to the caller/framework.
- This adapter does not connect Request.signal to guest cancellation; it does not add a stream ABI or resource methods to Core.

## Comparison

```sh
just compare-order-middleware
just check-order-middleware
```

[Measurements](../../docs/order-middleware.md) compare the same Rust workflow under Core Future and standard wit-bindgen/jco, plus an independent JS implementation. Common tests cover 196 requests, errors, Unicode and concurrency 32. Both Core modes are packed and installed into external applications for strict NodeNext/bundler TS and runtime checks.

HTTP/guest latency, warm-process startup and separately instrumented Rust heap are recorded. Actual copy counts, JS heap, Safari.app and production Workers are not measured. [Roadmap](../../docs/roadmap.md) tracks resource/stream/helper work separately.
