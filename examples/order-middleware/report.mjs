export function markdown(report, ja = false) {
  const sizes = report.entries
    .map(
      (e) =>
        `| ${e.backend} | ${e.mode} | ${e.wasm_bytes} B | ${e.js_bytes} B | ${e.total_bytes} B |`,
    )
    .join("\n");
  const perf = report.entries
    .map((e) => {
      const row = e.performance.find(
        (p) => p.boundary === "http" && p.items === 32 && p.concurrency === 1,
      );
      return `| ${e.backend} | ${e.mode} | ${e.startup.fresh_module_and_instance_ms.median.toFixed(3)} ms | ${row.us_per_call.median.toFixed(2)} µs |`;
    })
    .join("\n");
  const heap = report.entries
    .filter((e) => e.memory)
    .map((e) => {
      const m = e.memory.samples.at(-1);
      return `| ${e.backend} | ${e.mode} | ${e.memory.initial_linear_bytes} B | ${m.peak_requested_heap_bytes} B | ${m.after_requested_heap_bytes} B |`;
    })
    .join("\n");
  return ja
    ? `# 注文ミドルウェア：実用例と計測

[English](order-middleware.md) | 日本語

URL・HTTP・JSON は JS の標準 API、注文の検証・正規化・金額計算は Rust、認可は async host import に分担する。[実装と実行手順](../examples/order-middleware/README.md)。永続化する注文サーバーではなく、Request → 検証・見積もり → Response のミドルウェアである。

同じ [WIT](../examples/order-middleware/wit/app.wit) と [Rust の業務ロジック](../examples/order-middleware/src/workflow.rs)を Core Future と標準 wit-bindgen Component でビルドする。独立した JS 実装にも同じ HTTP アダプター・認可処理・期待値を使う。各構成 ${report.entries[0].verified.cases} ケース、並行数32。エラーと正常系の混在、Unicode、重複 SKU、価格衝突、u32 オーバーフローを含む。

計測日 ${report.created_at.slice(0, 10)}。${report.engine}、${report.machine.cpu}。

## 配布サイズ

| 実装 | Rust | Wasm | JS | 合計 |
|---|---|---:|---:|---:|
${sizes}

JS は HTTP/URL/JSON アダプターと共有ランタイムを含めて Rolldown で縮小する。Wasm は -Oz / LTO、同じ taraba-allocator（size classes 無効）。Component は jco の接続コードと実行する全 core Wasm を計上し、Component コンテナを重複して加算しない。認可ポリシーは共通のアプリ注入で、ネットワーク待ち時間は計測しない。JS 行に std/no_std の違いはない。

## 初期化と HTTP 全体の時間

| 実装 | Rust | 新規 module/instance | 32明細 HTTP / 並行1 |
|---|---|---:|---:|
${perf}

初期化は同一プロセス内の新しい ESM 識別子と instance で5回測定した中央値。エンジンのコンパイルキャッシュは消していないため、完全な cold start ではない。HTTP は Request の生成・本文の読み取り・JSON parse・guest 処理・Response の JSON 読み取りを含む。10バッチのウォームアップ、10バッチ×7サンプル。guest 単体と並行16の結果も [JSON](order-middleware-size.json) に保存する。実行速度の CI 閾値は設けない。

## メモリ

| 実装 | Rust | 初期 linear memory | 要求ヒープのピーク | 完了後の要求ヒープ |
|---|---|---:|---:|---:|
${heap}

32明細×並行32。サイズ・速度とは別の計装ビルドで、既存 rich-async の同じ counting allocator を使う。要求ヒープは Rust の Layout.size() の合計で、JS ヒープ・allocator metadata・断片化・静的 task pool を含めない。linear memory は pool・stack・予約ページを含む。完了後は timer/immediate を4回進めて測定する。JS の JSON/URL 処理や実際のコピー回数は計測しておらず、プロセス全体のメモリではない。

## 配布・再現・制限

Core の生成 npm に ./http entry を追加し、別アプリへ pack/install して NodeNext / bundler の strict TS と実行を確認する。標準の instantiate → attach は維持する。本文は64 KiBまでの bounded reader で読み、超過時に source を cancel する。WIT に渡す前に untrusted JSON の形と u32 の範囲を検査する。SKU はASCII、customer は UTF-8 80 B以内、明細は128件以内。これらはこの例の業務契約である。

Core と Component の例外・キャンセル契約は同一ではない。全バックエンドの per-call cancel や stream ABI 対応を示すものではない。Safari 向けの動作検証は WebKit E2E で完了。本番 Workers は未検証。

\`\`\`sh
just compare-order-middleware   # 計測してスナップショットを更新
just check-order-middleware     # 共通テスト・npm/TS・サイズ予算を確認
\`\`\`
`
    : `# Order middleware: example and measurements

English | [日本語](order-middleware.ja.md)

JS owns URL/HTTP/JSON parsing; Rust validates and normalizes orders, merges duplicate SKUs and checks totals; authorization is an async host import. This is a Request → validation/quote → Response middleware, not a persistence server. See the [example and usage](../examples/order-middleware/README.md).

Core Future and standard wit-bindgen Component compile the same [Rust workflow](../examples/order-middleware/src/workflow.rs) and [WIT](../examples/order-middleware/wit/app.wit). An independent JS baseline uses the same HTTP adapter, authorization and literal expected results. All backends pass ${report.entries[0].verified.cases} cases including concurrency 32, Unicode, duplicate SKUs, conflicting prices and u32 overflow.

Measured ${report.created_at.slice(0, 10)}; ${report.engine}; ${report.machine.cpu}.

## Deployed size

| Backend | Rust | Wasm | JS | Total |
|---|---|---:|---:|---:|
${sizes}

Includes the HTTP adapter, shared runtime and all deployed core Wasm; Rolldown minification, -Oz/LTO, the same allocator with size classes disabled. The Component container is not counted twice. The common injected authorization policy and network latency are excluded. std/no_std does not apply to the JS baseline.

## Startup and end-to-end HTTP

| Backend | Rust | Fresh module/instance | 32-line HTTP / concurrency 1 |
|---|---|---:|---:|
${perf}

Startup is the median of five fresh ESM identities/instances in one warm process, including JS import and Wasm compilation/instantiation. Engine caches are not flushed; this is not engine-cold startup. HTTP includes Request creation, bounded body reads, JSON parse, guest processing and Response JSON consumption. Ten warmup batches, seven samples of ten batches. [JSON](order-middleware-size.json) also records guest-only and concurrency-16 results. No noisy timing gate is enforced.

## Memory

| Backend | Rust | Initial linear memory | Peak requested heap | Requested heap after completion |
|---|---|---:|---:|---:|
${heap}

32 lines × concurrency 32. Separate instrumented builds reuse the rich-async counting allocator and are excluded from size/timing. Requested Rust heap excludes JS heap, allocator headers/fragmentation and static task pools. Linear memory includes pools, stack and reserved pages. Four timer/immediate turns drain deferred work. Actual copy counts and JS JSON/URL allocations are not measured; these are not process-wide memory figures.

## Distribution and reproduction

Core packages add a typed ./http export, then are packed, installed in an external app, checked with strict NodeNext/bundler TypeScript and executed. Wasm loading keeps standard instantiate → attach. Body reads stop at 64 KiB and cancel the source on overflow. Untrusted JSON shape/u32 ranges are checked before WIT conversion. This example restricts SKUs to ASCII, customers to 80 UTF-8 bytes and orders to 128 lines.

Core and Component have different exception/cancellation contracts. This does not establish cross-backend per-call cancellation or stream ABI support. Safari-target validation is complete through WebKit E2E; production Workers remain unverified.

\`\`\`sh
just compare-order-middleware
just check-order-middleware
\`\`\`
`;
}
