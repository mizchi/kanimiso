export function markdown(report, ja = false) {
  const sizeRows = report.entries
    .map(
      (e) =>
        `| ${e.backend} | ${e.mode} | ${e.wasm_bytes.toLocaleString("en-US")} B | ${e.js_bytes.toLocaleString("en-US")} B | ${e.total_bytes.toLocaleString("en-US")} B |`,
    )
    .join("\n");
  const perfRows = report.entries
    .map(
      (e) =>
        `| ${e.backend} | ${e.mode} | ${e.performance.map((p) => p.median_us_per_call.toFixed(2) + " µs").join(" | ")} |`,
    )
    .join("\n");
  const memoryRows = report.entries
    .map((e) => {
      const m = e.memory.measurements.at(-1);
      return `| ${e.backend} | ${e.mode} | ${e.memory.initial_linear_bytes.toLocaleString("en-US")} B | ${m.peak_requested_heap_bytes.toLocaleString("en-US")} B | ${m.after_requested_heap_bytes.toLocaleString("en-US")} B | ${m.linear_bytes.toLocaleString("en-US")} B |`;
    })
    .join("\n");
  return ja
    ? `# 複合型の async 比較

[English](rich-async-size.md) | 日本語

同じ WIT の record・string・list<u8>・result を使い、同じ Rust の [処理](../experiments/rich-async/src/workflow.rs)を実行する。Rust と JS の間を二度 await し、文字列の追記、バイト列の wrapping 演算、ホストでの変換を行う。標準 wit-bindgen との比較は Component の Canonical ABI＋jco、taraba は Core の private Promise ABI である。

計測日: ${report.created_at.slice(0, 10)}。${report.engine}、${report.machine.cpu}。Safari 実機・Wasmtime/WASI の計測ではない。

## 配布サイズ

| 実装 | Rust | Wasm | JS | 合計 |
|---|---|---:|---:|---:|
${sizeRows}

Wasm は wasm-opt -Oz、Rust は LTO・1 codegen unit・panic=abort。両方とも同じ taraba-allocator、default-features=false。JS は Rolldown で一つの ESM に縮小。wit-bindgen 0.58.0 は macros/async のみで async-spawn は無効。jco 1.39.0 が生成した実行用 Core Wasm と JS をすべて含み、Component コンテナや型定義との二重計上は避けた。taraba の JS には共有ランタイムも含む。

## 実行時間

1 呼び出し当たりの中央値。非計装のサイズ計測用ビルドで、30 バッチのウォームアップ後、20 バッチ×7 サンプル。ホスト側は両方とも同じ Promise microtask を待つ。Node は --no-liftoff。並行数16ではバッチ時間を呼び出し数で割った値であり、個々のリクエストのレイテンシではない。

| 実装 | Rust | 32 B / 並行1 | 32 B / 並行16 | 1 KiB / 並行1 | 1 KiB / 並行16 |
|---|---|---:|---:|---:|---:|
${perfRows}

このエンジン・バージョン・ワークロードでの観測値。Canonical async のスケジューラと Core の microtask 実行契約の違いも含む。一般的な Rust Future や JSPI の速度差を示すものではない。測定の最小・最大値も JSON に記録する。

## メモリ

同一のカウンタ付きアロケータを載せた別ビルドで測定し、サイズと速度には計装を含めない。次の表は 1 KiB の payload × 並行128を含む一連のバッチ後の値。各バッチ前後に timer/immediate を4回ずつ進める。

| 実装 | Rust | 初期 linear memory | Rust要求ヒープのピーク | 完了後の要求ヒープ | linear memory 到達値 |
|---|---|---:|---:|---:|---:|
${memoryRows}

要求ヒープは Layout.size() の合計で、アロケータのヘッダ・断片化・JS ヒープ・静的タスク領域を含まない。linear memory は静的領域・スタック・予約ページを含む。taraba は 1,024×128 B の静的プールを持つため、初期 linear memory は大きい。これらの値をプロセス全体のメモリ使用量として扱わない。

この wit-bindgen/jco 構成では、Promise 完了とイベントループの待機後も要求ヒープが残った。繰り返し呼び出す独立プローブでも残存量が増え、戻り値は guest memory の view ではなかった。観測した cabi_realloc 呼び出しには new_size=0 の解放がなく、生成 glue の値変換境界の解放処理を調査対象として絞れる。ただし、どの境界の割り当てかは未特定で、標準 Component 全般のリークやメモリ効率を断定する根拠にはしない。バッチ前後の値は JSON に残している。

## 再現と検証

\`just compare-rich-async\` で JSON と日英の表を更新する。Unicode・空文字・空配列・64 KiB・u32 の wrap・ドメインエラー・入力コピー・並行実行とエラー後の再利用を含む、同じ216ケースを各ビルドで通す。計測用ビルドでも同じテストを通す。

[JSON](rich-async-size.json) · [WIT](../experiments/rich-async/wit/app.wit) · [共通テスト](../experiments/rich-async/contract.mjs) · [計測コード](../tools/compare-rich-async.mjs)
`
    : `# Rich async comparison

English | [日本語](rich-async-size.ja.md)

Both backends run the same WIT record/string/list<u8>/result workload and the exact same [Rust workflow](../experiments/rich-async/src/workflow.rs): two async host transforms, string appends and wrapping byte arithmetic. Standard wit-bindgen uses the Component Canonical ABI plus jco; taraba uses its private Core Promise ABI.

Measured ${report.created_at.slice(0, 10)} on ${report.engine}, ${report.machine.cpu}. This is not a Safari browser or Wasmtime/WASI measurement.

## Deployed size

| Backend | Rust | Wasm | JS | Total |
|---|---|---:|---:|---:|
${sizeRows}

Both use wasm-opt -Oz, Rust LTO, one codegen unit, panic=abort and the same taraba-allocator with default features disabled. Rolldown produces one minified ESM. wit-bindgen 0.58.0 enables macros/async without async-spawn; all deployed jco 1.39.0 Core Wasm and JS are counted. Component containers and declarations are excluded from the runtime total to avoid double counting. taraba JS includes the shared runtime.

## Execution time

Median microseconds per call in non-instrumented release artifacts. Thirty warmup batches, seven samples of twenty batches, identical host Promise microtasks, Node --no-liftoff. Concurrency16 divides batch duration by calls; it is throughput time per call, not request latency.

| Backend | Rust | 32 B / concurrency1 | 32 B / concurrency16 | 1 KiB / concurrency1 | 1 KiB / concurrency16 |
|---|---|---:|---:|---:|---:|
${perfRows}

These observations apply to this engine, version and workload. They include the Canonical async scheduler versus Core microtask scheduling contracts; they are not a general Rust Future versus JSPI result. JSON also records sample minima and maxima.

## Memory

Separate binaries use the identical counting allocator wrapper; instrumentation is excluded from size and timing. The table shows the last batch in a sequence ending with 1 KiB payloads × concurrency128. Four timer/immediate turns before and after each batch allow deferred post-return work to run.

| Backend | Rust | Initial linear memory | Peak requested Rust heap | Requested heap after completion | Linear memory high-water mark |
|---|---|---:|---:|---:|---:|
${memoryRows}

Requested heap counts Layout.size() and excludes allocator metadata, fragmentation, JS heap and static task storage. Linear memory includes static data, stack and reserved pages. taraba's 1,024×128 B static pool increases its initial linear memory. Neither metric is whole-process memory use.

This wit-bindgen/jco configuration retains requested heap after Promise completion and event-loop turns. An isolated repeated-call probe also retains bytes; outputs do not share guest memory, and no new_size=0 cabi_realloc calls were observed. This narrows investigation to cleanup at generated glue value boundaries, but the exact allocation site is not established. This observation does not establish a general Component memory leak or efficiency claim. Per-batch before/after counters are recorded in JSON.

## Reproduction and verification

Run \`just compare-rich-async\` to update JSON and both language tables. Each normal and instrumented build passes the same 216 cases covering Unicode, empty strings/arrays, 64 KiB, u32 wrapping, domain errors, input copies, concurrency and reuse after errors.

[JSON](rich-async-size.json) · [WIT](../experiments/rich-async/wit/app.wit) · [Shared tests](../experiments/rich-async/contract.mjs) · [Measurement runner](../tools/compare-rich-async.mjs)
`;
}
