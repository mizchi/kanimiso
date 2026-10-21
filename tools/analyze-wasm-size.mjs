import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { wasmSections } from "./wasm-sections.mjs";
import { optimizationArgs } from "./wasm-opt-contract.mjs";
import { verifyWit } from "../tests/support/wit-contract.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";
import { verifyScheduling } from "../tests/support/scheduling.mjs";

const out = resolve(".cache/wasm-size-analysis"),
  binaryen = resolve(".cache/toolchains/binaryen-version_133/bin"),
  tools = resolve(".cache/toolchains/wasm-size-tools/bin"),
  cli = resolve("target/release/taraba"),
  wasmTools = resolve(
    ".cache/toolchains/wasm-tools-1.245.1-aarch64-macos/wasm-tools",
  );
mkdirSync(out, { recursive: true });
const run = (bin, args) =>
  execFileSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const source = JSON.parse(readFileSync("docs/async-size.json"));
assert.ok(source.all_passed);
for (const [file, sha] of Object.entries(source.inputs))
  assert.equal(
    hash(file),
    sha,
    `stale size baseline: ${file}; run just compare-async-size`,
  );
const batches = [1, 16, 128, 1024].flatMap(asyncCases);
const report = {
  created_at: new Date().toISOString(),
  engine: `Node ${process.version} / V8 ${process.versions.v8}`,
  versions: {
    twiggy: run(join(tools, "twiggy"), ["--version"]).trim(),
    wasm_snip: run(join(tools, "wasm-snip"), ["--version"]).trim(),
    wasm_tools: run(wasmTools, ["--version"]).trim(),
    binaryen: 133,
  },
  source_snapshot: source.created_at,
  profiles: [],
  negative_controls: [],
  production_policy_changed: false,
  safari_browser_verified: false,
};
function inspect(file) {
  const bytes = readFileSync(file),
    sections = wasmSections(bytes);
  assert.equal(8 + sections.reduce((n, s) => n + s.bytes, 0), bytes.length);
  const data = Buffer.concat(
    sections
      .filter((s) => s.id === 11)
      .map((s) => bytes.subarray(s.payload_start, s.end)),
  );
  return {
    bytes: bytes.length,
    sha256: hash(file),
    sections,
    custom_bytes: sections
      .filter((s) => s.id === 0)
      .reduce((n, s) => n + s.bytes, 0),
    code_bytes: sections
      .filter((s) => s.id === 10)
      .reduce((n, s) => n + s.bytes, 0),
    data_bytes: sections
      .filter((s) => s.id === 11)
      .reduce((n, s) => n + s.bytes, 0),
    data_strings: [
      ...new Set(data.toString("latin1").match(/[ -~]{8,}/g) ?? []),
    ],
  };
}
function twiggy(file, command = "top", args = []) {
  return JSON.parse(
    run(join(tools, "twiggy"), [command, file, "-f", "json", ...args]),
  );
}
function build(raw, profile, dir, named = false) {
  run(cli, [
    "build",
    raw,
    "--wit",
    resolve(
      `experiments/async-size/core/wit/${profile === "future" ? "future" : "sync"}`,
    ),
    `--${profile}`,
    "--out-dir",
    dir,
    "--binaryen",
    named ? join(out, "named-bin") : binaryen,
  ]);
  return join(dir, "app.wasm");
}
function snip(raw, flags, file) {
  run(join(tools, "wasm-snip"), [
    raw,
    "--skip-producers-section",
    ...flags,
    "-o",
    file,
  ]);
}
async function connect(pkg, file, bindings) {
  const { createHost } = await import(pathToFileURL(join(pkg, "index.js")));
  const host = createHost({ bindings });
  const { instance } = await WebAssembly.instantiate(
    readFileSync(file),
    host.imports,
  );
  host.attach(instance.exports);
  return host;
}
async function verify(pkg, file, profile) {
  run(wasmTools, ["validate", file]);
  const factory = async (add) => (await connect(pkg, file, { add })).run;
  const common = await verifyWit(factory, batches);
  const scheduling = await verifyScheduling(factory, {
    serialized: profile === "jspi",
  });
  for (const stage of [1, 2]) {
    const reason = { stage };
    let count = 0;
    const host = await connect(pkg, file, {
      add: (a, b) =>
        ++count === stage
          ? Promise.reject(reason)
          : Promise.resolve((a + b) | 0),
    });
    await assert.rejects(host.run(7, 9), (e) => e === reason);
    if (profile === "jspi") {
      assert.ok(host.stats().dead);
      await assert.rejects(host.run(1, 2), (e) => e === reason);
    } else {
      assert.equal(await host.run(1, 2), 4);
      assert.equal(
        host.stats().live_values +
          host.stats().live_waits +
          host.stats().live_tasks,
        0,
      );
    }
  }
  return { ...common, scheduling, rejection_identity_and_recovery: true };
}
// Keep names through every Binaryen stage only in this analysis view. Shipped
// builds keep their normal flags. Names may change index ordering; sizes below
// must match every non-custom section of the deployed artifact exactly.
const namedBin = join(out, "named-bin");
mkdirSync(namedBin, { recursive: true });
writeFileSync(join(namedBin, "package.json"), '{"type":"module"}\n');
for (const name of ["wasm-as", "wasm-merge", "wasm-metadce", "wasm-opt"]) {
  const file = join(namedBin, name);
  rmSync(file, { force: true });
  writeFileSync(
    file,
    `#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2).map(a=>a==='--strip-debug'?'--strip-dwarf':a);
if(!args.includes('--version'))args.push('--debuginfo');
const r=spawnSync(${JSON.stringify(join(binaryen, name))},args,{stdio:'inherit'});
process.exit(r.status??1);
`,
    { mode: 0o755 },
  );
}

for (const profile of ["jspi", "future"])
  for (const mode of ["no_std", "std"]) {
    const id = `${profile}-${mode}`,
      dir = join(out, id);
    mkdirSync(dir, { recursive: true });
    const baselineDir = resolve(`.cache/async-size/${id}-taraba-async`),
      baseline = join(baselineDir, "pkg/app.wasm"),
      raw = join(baselineDir, "raw.wasm"),
      pkg = join(baselineDir, "pkg");
    const named = build(raw, profile, join(dir, "named"), true);
    const stats = inspect(baseline),
      namedStats = inspect(named);
    const layout = (info) =>
      info.sections.filter((s) => s.id !== 0).map((s) => [s.id, s.bytes]);
    assert.deepEqual(
      layout(namedStats),
      layout(stats),
      `${id}: named analysis layout differs`,
    );
    const top = twiggy(baseline),
      namedTop = twiggy(named),
      rawTop = twiggy(raw);
    const item = {
      id,
      raw: inspect(raw),
      deployed: stats,
      twiggy_top: top.slice(0, 20),
      named_analysis: {
        bytes: namedStats.bytes,
        custom_bytes: namedStats.custom_bytes,
        matches_deployed_section_sizes: true,
        byte_identity_promised: false,
        top: namedTop
          .filter((r) => !/subsection|custom section/.test(r.name))
          .slice(0, 20),
        retained: twiggy(named, "top", ["--retained", "-n", "15"]),
        paths_to_fmt: run(join(tools, "twiggy"), [
          "paths",
          named,
          "--regex",
          ".*fmt.*write.*",
          "-r",
          "4",
          "-d",
          "7",
        ]),
      },
      raw_target_counts: Object.fromEntries(
        [
          [
            "fmt",
            /(?:4core3fmt|3std3fmt|(?:core|std)(?:\[[^\]]+\])?::fmt::|core\.\.fmt\.\.|std\.\.fmt\.\.)/,
          ],
          [
            "panic",
            /(?:4core9panicking|3std9panicking|(?:core|std)(?:\[[^\]]+\])?::panicking::)/,
          ],
        ].map(([key, re]) => [
          key,
          rawTop.filter((r) => re.test(r.name)).length,
        ]),
      ),
      variants: [],
    };
    for (const variant of [
      "baseline",
      "strip-all",
      "reopt",
      "memory-packing",
      "strip-raw-custom",
      "snip-roundtrip",
      "snip-fmt",
      "snip-panic",
      "snip-both",
    ]) {
      let file = baseline;
      if (variant === "strip-all") {
        file = join(dir, "strip-all.wasm");
        run(wasmTools, ["strip", "--all", baseline, "-o", file]);
      } else if (variant === "strip-raw-custom") {
        const stripped = join(dir, "stripped-raw.wasm");
        run(wasmTools, ["strip", "--all", raw, "-o", stripped]);
        file = build(stripped, profile, join(dir, variant));
      } else if (variant === "reopt" || variant === "memory-packing") {
        file = join(dir, `${variant}.wasm`);
        run(join(binaryen, "wasm-opt"), [
          baseline,
          ...optimizationArgs("Oz"),
          ...(variant === "memory-packing" ? ["--memory-packing"] : []),
          "--converge",
          "-o",
          file,
        ]);
      } else if (variant.startsWith("snip-")) {
        const snipped = join(dir, `${variant}.raw.wasm`);
        snip(
          raw,
          [
            ...(variant === "snip-fmt" || variant === "snip-both"
              ? ["--snip-rust-fmt-code"]
              : []),
            ...(variant === "snip-panic" || variant === "snip-both"
              ? ["--snip-rust-panicking-code"]
              : []),
          ],
          snipped,
        );
        file = build(snipped, profile, join(dir, variant));
      }
      const row = {
        variant,
        ...inspect(file),
        exports: WebAssembly.Module.exports(
          new WebAssembly.Module(readFileSync(file)),
        ),
        verified: await verify(pkg, file, profile),
      };
      if (variant === "strip-all")
        assert.equal(
          row.sha256,
          stats.sha256,
          "deployed Core should contain no custom sections",
        );
      item.variants.push(row);
      console.log(
        `${id}/${variant}: ${row.bytes} B; ${row.verified.tasks} cases, scheduling/rejection passed`,
      );
    }
    // Names have already been stripped here. Record compatibility without treating
    // a parser failure as successful optimization or silently replacing the tool.
    try {
      const file = join(dir, "snip-after-strip.wasm");
      snip(
        baseline,
        ["--snip-rust-fmt-code", "--snip-rust-panicking-code"],
        file,
      );
      item.snip_after_strip = {
        supported: true,
        named_targets: 0,
        ...inspect(file),
        verified: await verify(pkg, file, profile),
      };
    } catch (error) {
      item.snip_after_strip = {
        supported: false,
        error: String(error.stderr || error.message),
      };
    }
    report.profiles.push(item);
  }

// Negative controls: passing arithmetic tests does not authorize removing fmt
// or panic machinery from every application.
const negative = join(out, "semantics");
mkdirSync(join(negative, "src"), { recursive: true });
writeFileSync(
  join(negative, "Cargo.toml"),
  `[package]
name="wasm-size-semantics"
version="0.0.0"
edition="2024"
[workspace]
[lib]
crate-type=["cdylib"]
[dependencies]
taraba-allocator={path=${JSON.stringify(resolve("crates/taraba-allocator"))},default-features=false}
[profile.release]
opt-level="z"
lto=true
codegen-units=1
panic="abort"
strip=false
`,
);
writeFileSync(
  join(negative, "src/lib.rs"),
  `#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[link(wasm_import_module="$root")]
unsafe extern "C" { #[link_name="panic-observed"] fn observed(); }
#[unsafe(export_name="format-length")]
pub extern "C" fn format_length(n:u32)->u32 { format!("value={n}").len() as u32 }
#[unsafe(export_name="panic-with-hook")]
pub extern "C" fn panic_with_hook() {
    std::panic::set_hook(Box::new(|_|unsafe{observed()}));
    panic!("size analysis negative control");
}
`,
);
writeFileSync(
  join(negative, "app.wit"),
  "package taraba:size; world app { import panic-observed:func(); export format-length:func(n:u32)->u32; export panic-with-hook:func(); }",
);
execFileSync(
  "cargo",
  [
    "build",
    "--offline",
    "--manifest-path",
    join(negative, "Cargo.toml"),
    "--release",
    "--target",
    "wasm32-unknown-unknown",
  ],
  {
    stdio: "pipe",
    env: { ...process.env, CARGO_TARGET_DIR: join(negative, "target") },
  },
);
const negativeRaw = join(
  negative,
  "target/wasm32-unknown-unknown/release/wasm_size_semantics.wasm",
);
for (const variant of ["baseline", "snip-fmt", "snip-panic", "snip-both"]) {
  let raw = negativeRaw;
  if (variant !== "baseline") {
    raw = join(negative, `${variant}.wasm`);
    snip(
      negativeRaw,
      [
        ...(variant !== "snip-panic" ? ["--snip-rust-fmt-code"] : []),
        ...(variant !== "snip-fmt" ? ["--snip-rust-panicking-code"] : []),
      ],
      raw,
    );
  }
  const pkg = join(negative, variant);
  run(cli, [
    "build",
    raw,
    "--jspi",
    "--wit",
    join(negative, "app.wit"),
    "--out-dir",
    pkg,
    "--binaryen",
    binaryen,
  ]);
  const file = join(pkg, "app.wasm");
  let hookCalls = 0;
  const bindings = { "panic-observed": () => hookCalls++ };
  const host = await connect(pkg, file, bindings);
  let formatting;
  try {
    for (const n of [0, 42, 0xffffffff])
      assert.equal(await host["format-length"](n), `value=${n}`.length);
    formatting = "passed";
  } catch (error) {
    assert.ok(error instanceof WebAssembly.RuntimeError);
    formatting = "trapped";
  }
  const panicHost = await connect(pkg, file, bindings);
  await assert.rejects(
    panicHost["panic-with-hook"](),
    WebAssembly.RuntimeError,
  );
  assert.equal(
    formatting,
    variant === "snip-fmt" || variant === "snip-both" ? "trapped" : "passed",
  );
  assert.equal(
    hookCalls,
    variant === "snip-panic" || variant === "snip-both" ? 0 : 1,
  );
  report.negative_controls.push({
    variant,
    formatting,
    panic_hook_calls: hookCalls,
    wasm_bytes: readFileSync(file).length,
  });
}
report.inputs = Object.fromEntries(
  [
    "tools/analyze-wasm-size.mjs",
    "tools/wasm-sections.mjs",
    "tools/install-wasm-size-tools.mjs",
    "tools/wasm-opt-contract.mjs",
    "docs/async-size.json",
    "tests/support/wit-contract.mjs",
    "tests/support/scheduling.mjs",
    "tests/support/async-contract.mjs",
  ].map((f) => [f, hash(f)]),
);
report.all_passed = true;
writeFileSync(
  "docs/wasm-size-analysis.json",
  JSON.stringify(report, null, 2) + "\n",
);
const variants = [
  "baseline",
  "strip-all",
  "reopt",
  "memory-packing",
  "strip-raw-custom",
  "snip-roundtrip",
  "snip-fmt",
  "snip-panic",
  "snip-both",
];
const matrix = variants
  .map(
    (v) =>
      `| ${v} | ${report.profiles.map((p) => p.variants.find((r) => r.variant === v).bytes.toLocaleString("en-US")).join(" | ")} |`,
  )
  .join("\n");
const sectionRows = report.profiles
  .map(
    (p) =>
      `| ${p.id} | ${p.deployed.bytes} | ${p.deployed.code_bytes} | ${p.deployed.data_bytes} | ${p.deployed.custom_bytes} |`,
  )
  .join("\n");
const top = report.profiles
  .find((p) => p.id === "future-std")
  .named_analysis.top.slice(0, 12)
  .map((r) => `| ${r.shallow_size} | ${r.name.replaceAll("|", "\\|")} |`)
  .join("\n");
writeFileSync(
  "docs/wasm-size-analysis.md",
  `# Wasm サイズの内訳と snip の実験

${report.created_at} / ${report.engine}

同じ二段 await の共通3,507ケースで、JSPI/Future × std/no_std を比較した。全 runnable variant で実際の二回の host I/O、待機の順序、reject の同一性と再利用/first-fatal の契約を検証済み。Safari 向け検証は[WebKit E2E の方針](browser-testing.ja.md)に従う。製品の最適化ポリシーは変更していない。

\`just analyze-wasm-size\` は通常のサイズ比較を再ビルドしてから、twiggy 0.8.0 / wasm-snip 0.4.0 / Binaryen 133 / wasm-tools 1.245.1 で再現する。入力と成果物の SHA-256、全 variant、twiggy の top/retained/paths は [JSON](wasm-size-analysis.json) に記録する。

## custom section と data section

custom section（ID 0）は名前・DWARF・producer 等のメタデータ。data section（ID 11）は線形メモリの初期値で、文字列だけでなく Waker/task の vtable なども含む。両者は別物で、data を一括削除する処理は行わない。

| 構成 | 配布 Wasm B | code section B | data section B | custom section B |
|---|---:|---:|---:|---:|
${sectionRows}

section の数値は ID/長さのヘッダー込み。残りは型、import/export、table、global、element 等。raw の DWARF/name は大きいが既定の CLI が除去済み。\`wasm-tools strip --all\` 後も配布バイナリの SHA-256 は同一だった。

## 比較結果

| 操作 | JSPI no_std B | JSPI std B | Future no_std B | Future std B |
|---|---:|---:|---:|---:|
${matrix}

\`reopt\` は配布 Wasm に Oz/converge を再適用した対照。\`memory-packing\` は同じ処理に当該 pass を追加。\`snip-roundtrip\` は除去対象なしで wasm-snip を通した対照であり、再エンコードの影響を除去効果と混同しない。snip は名前が残る Rust 出力に適用し、その後、通常と同じ Core lowering・pool merge・Oz/flatten/rereloop/Oz/converge を行った。JS のサイズはこの表に含めない。

strip-raw-custom は Core lowering より前に custom section を除去した順序の対照。Canonical ABI の metadata を先に失うと補助 export の除去判断に影響し、今回の4構成はすべて大きくなった。各 variant の export 一覧も JSON に記録する。この実験の対象は Core であり、Component の型 metadata の削除可否とは分けて扱う。

snip 後も data section の文字列が残り得る。関数を trap に置換しても、線形メモリの初期値すべてを削除できるという意味ではない。詳細な文字列と section サイズは JSON に残した。

名前を除去した後の wasm-snip も試した。JSPI は読み込めるが名前による対象指定はできず、Future の externref table は wasm-snip 0.4.0 の parser が invalid table type として拒否した。名前が残り、Core lowering より前の Rust 出力に適用する順序が必要だった。

## twiggy の内訳

配布済み Wasm の top は \`code[n]\` になるため、全 Binaryen 段で名前を保つ解析専用の view も作った。追加した名前は配布サイズに計上しない。非 custom section ごとのサイズ一致を検証しているが、関数・型の index 順序が変わることがあり、バイト列同一とは扱わない。下表は Future/std の解析 view の shallow size。

| B | 項目 |
|---:|---|
${top}

retained size は支配関係に依存し、各行を単純に足して除去量とはしない。fmt の保持経路には panic payload と funcref table が見える。実際に消せた量は上の snip の差分で判断する。poll_task の数値にはアプリの Future の poll が inline された部分も含まれ、ランタイム単体の固定費ではない。

## 意味が変わることの確認

通常経路のテストが通っても、全アプリへ無条件に適用できるわけではない。別の std fixture で動的な \`format!("value={n}")\` と panic hook を確認した。

| 操作 | 動的 format | panic hook 呼び出し数 |
|---|---|---:|
${report.negative_controls.map((c) => `| ${c.variant} | ${c.formatting} | ${c.panic_hook_calls} |`).join("\n")}

fmt snip は正規の formatting 経路を trap にし、panicking snip は hook の設定・呼び出しを含む panic 契約を変える。現時点では opt-in の実験として扱う。custom section だけを除く strip とは意味が異なる。

[twiggy](https://github.com/rustwasm/twiggy) / [wasm-snip の実装](https://docs.rs/wasm-snip/0.4.0/src/wasm_snip/lib.rs.html) / [現在の通常ビルド比較](async-size.ja.md)
`,
);
console.log(
  "Wrote docs/wasm-size-analysis.md and JSON; production policy unchanged.",
);
