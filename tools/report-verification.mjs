import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const read = (name) => JSON.parse(readFileSync(`.cache/${name}.json`)),
  check = read("check"),
  stress = read("stress"),
  workers = read("workers"),
  modern = read("modern"),
  miri = readFileSync(".cache/miri.log", "utf8"),
  kani = readFileSync(".cache/kani.log", "utf8");
for (const r of [check, stress, workers, modern])
  assert.equal(r.all_passed, true);
assert.equal((kani.match(/VERIFICATION:- SUCCESSFUL/g) ?? []).length, 6);
assert.doesNotMatch(kani, /VERIFICATION:- FAILED/);
assert.equal((miri.match(/test result: ok/g) ?? []).length, 4);
const sizes = check.entries.map((e) => ({
  variant: e.variant,
  mode: e.mode,
  ...e.sizes,
  host_bundle: e.sizes.wasm + e.sizes.host,
}));
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((f) => f && !f.startsWith("docs/verification."));
const inputs = Object.fromEntries(
  files.map((f) => [
    f,
    createHash("sha256").update(readFileSync(f)).digest("hex"),
  ]),
);
const report = {
  created_at: new Date().toISOString(),
  engine: check.engine,
  inputs,
  sizes,
  checks: {
    runtime_configurations: 4,
    regressions_per_configuration: 22,
    fatal_per_configuration: 9,
    fuzz_steps_per_configuration: 10000,
  },
  stress: {
    duration_s: stress.duration_s,
    rounds: stress.rounds,
    runs: stress.runs.length,
    steps: stress.steps,
  },
  workers: { configurations: workers.entries.length, local_only: true },
  modern: modern.engines.map((e) => ({
    name: e.name,
    all_passed: e.result.all_passed,
    ...(e.limitation ? { limitation: e.limitation } : {}),
  })),
  miri: { suite_runs: 4, tests: 16, passed: true },
  kani: {
    proved: 6,
    scope:
      "2 ID model, 1 production Waker, 3 allocator boundaries. Native 64-bit; mock page backend. Not the whole runtime or JS engine.",
    exploratory:
      "Two live allocations / adjacent coalescing exploratory harnesses timed out in a broader run. Not counted as proved; rerun with just kani-explore.",
  },
  all_passed: true,
};
writeFileSync("docs/verification.json", JSON.stringify(report, null, 2) + "\n");
const rows = sizes
  .map(
    (s) =>
      `| ${s.variant}/${s.mode} | ${s.wasm} | ${s.host} | ${s.host_bundle} |`,
  )
  .join("\n");
writeFileSync(
  "docs/verification.md",
  `# 抽出時の検証\n\n${report.created_at} / ${report.engine}\n\n## サイズ\n\n| 構成 | Wasm B | JS host B | Wasm + host B |\n|---|---:|---:|---:|\n${rows}\n\nWasm は二段 await の最小サンプル。runtime 単体の固定費ではない。アプリの Future 等を含む。\nWIT bindings を含む共有ランタイムを計上し、アプリ固有 API の生成コードは別途サイズ比較で扱う。\nstd のパス文字列は移動で変わるため、元とのサイズ差全体を最適化効果とはみなさない。\n\n## 確認結果\n\n- \`just check\`: release/debug × std/no_std。各構成で同じ計算、22 回帰、9 異常終了、storage/capacity、10,000 step fuzz。Node unit と native Rust も通過。\n- \`just stress 60\`: ${stress.duration_s.toFixed(2)} 秒、${stress.rounds} seeds、${stress.runs.length} runs、${stress.steps.toLocaleString("en-US")} steps。同じ seed の std/no_std の観測値が一致し、memory は 256 KiB。\n- \`just miri\`: runtime std/no_std 各3件、allocator 8件、extra assertions を有効にした merge 2件の計16件。\n- \`just kani\`: ID モデル2件、実装 Waker 1件、allocator 境界3件の計6 proof。\n- \`just workers\`: local workerd、release/debug × std/no_std の4構成。各3507タスク、追加20チェック、JS roots の解放。Cloudflare本番未deploy。\n- \`just modern\`: V8 と system JavaScriptCore で js-string / exnref / typed funcref / GC と現行 std/no_std の同一計算が通過。\n\nSafari 実ブラウザーは未検証。JavaScriptCore shell では HTML の queueMicrotask を Promise ジョブで補う。\nKani は native 64-bit と mock backend の部品検証。JS / engine / Wasm layout / intrusive WAT 全体の形式証明ではない。\n複数 live allocation と隣接 free 結合の探索的 proof は広い条件での実行が時間切れとなり、証明済み数に含めない。\n必要なら \`just kani-explore\` で別途確認する。Miri/native/実 Wasm の対応テストは通過。\n\n入力 SHA-256 と機械可読の集計は [verification.json](verification.json)。\n元ファイルの来歴は [provenance.json](../provenance.json)。生のログはローカルの .cache にある。\n`.replaceAll(
    "\`",
    "`",
  ),
);
console.log("docs/verification.md / docs/verification.json");
