# Order middleware: example and measurements

English | [日本語](order-middleware.ja.md)

JS owns URL/HTTP/JSON parsing; Rust validates and normalizes orders, merges duplicate SKUs and checks totals; authorization is an async host import. This is a Request → validation/quote → Response middleware, not a persistence server. See the [example and usage](../examples/order-middleware/README.md).

Core Future and standard wit-bindgen Component compile the same [Rust workflow](../examples/order-middleware/src/workflow.rs) and [WIT](../examples/order-middleware/wit/app.wit). An independent JS baseline uses the same HTTP adapter, authorization and literal expected results. All backends pass 196 cases including concurrency 32, Unicode, duplicate SKUs, conflicting prices and u32 overflow.

Measured 2026-10-21; Node v24.21.0 / V8 13.6.233.17-node.53; Apple M5.

## Deployed size

| Backend | Rust | Wasm | JS | Total |
|---|---|---:|---:|---:|
| javascript | host | 0 B | 3014 B | 3014 B |
| taraba | no_std | 6942 B | 6593 B | 13535 B |
| taraba | std | 11014 B | 6593 B | 17607 B |
| wit-bindgen | no_std | 15411 B | 85065 B | 100476 B |
| wit-bindgen | std | 26024 B | 85065 B | 111089 B |

Includes the HTTP adapter, shared runtime and all deployed core Wasm; Rolldown minification, -Oz/LTO, the same allocator with size classes disabled. The Component container is not counted twice. The common injected authorization policy and network latency are excluded. std/no_std does not apply to the JS baseline.

## Startup and end-to-end HTTP

| Backend | Rust | Fresh module/instance | 32-line HTTP / concurrency 1 |
|---|---|---:|---:|
| javascript | host | 0.094 ms | 31.34 µs |
| taraba | no_std | 0.520 ms | 63.13 µs |
| taraba | std | 0.919 ms | 62.76 µs |
| wit-bindgen | no_std | 1.626 ms | 1250.70 µs |
| wit-bindgen | std | 1.648 ms | 1582.62 µs |

Startup is the median of five fresh ESM identities/instances in one warm process, including JS import and Wasm compilation/instantiation. Engine caches are not flushed; this is not engine-cold startup. HTTP includes Request creation, bounded body reads, JSON parse, guest processing and Response JSON consumption. Ten warmup batches, seven samples of ten batches. [JSON](order-middleware-size.json) also records guest-only and concurrency-16 results. No noisy timing gate is enforced.

## Memory

| Backend | Rust | Initial linear memory | Peak requested heap | Requested heap after completion |
|---|---|---:|---:|---:|
| taraba | no_std | 262144 B | 33671 B | 0 B |
| taraba | std | 262144 B | 33671 B | 0 B |
| wit-bindgen | no_std | 131072 B | 1923 B | 0 B |
| wit-bindgen | std | 131072 B | 1923 B | 0 B |

32 lines × concurrency 32. Separate instrumented builds reuse the rich-async counting allocator and are excluded from size/timing. Requested Rust heap excludes JS heap, allocator headers/fragmentation and static task pools. Linear memory includes pools, stack and reserved pages. Four timer/immediate turns drain deferred work. Actual copy counts and JS JSON/URL allocations are not measured; these are not process-wide memory figures.

## Distribution and reproduction

Core packages add a typed ./http export, then are packed, installed in an external app, checked with strict NodeNext/bundler TypeScript and executed. Wasm loading keeps standard instantiate → attach. Body reads stop at 64 KiB and cancel the source on overflow. Untrusted JSON shape/u32 ranges are checked before WIT conversion. This example restricts SKUs to ASCII, customers to 80 UTF-8 bytes and orders to 128 lines.

Core and Component have different exception/cancellation contracts. This does not establish cross-backend per-call cancellation or stream ABI support. Safari-target validation is complete through WebKit E2E; production Workers remain unverified.

```sh
just compare-order-middleware
just check-order-middleware
```
