import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import os from "node:os";
import { artifactSizes } from "../tests/support/metrics.mjs";
import esbuild from "esbuild";
import { optimizationArgs } from "./wasm-opt-contract.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";
import { verifyWit, timeWit } from "../tests/support/wit-contract.mjs";
const root = resolve("."),
  out = resolve(".cache/wit-comparison");
mkdirSync(out, { recursive: true });
const binaryen = resolve(".cache/toolchains/binaryen-version_133/bin");
const run = (bin, args, options = {}) => {
  const t = performance.now();
  try {
    execFileSync(bin, args, {
      stdio: "pipe",
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
  } catch (e) {
    writeFileSync(`${out}/failure.log`, String(e.stderr || e));
    throw Error(`${bin} failed; see ${out}/failure.log`);
  }
  return performance.now() - t;
};
const cases = [1, 16, 128, 1024].flatMap((c) => asyncCases(c));
const report = {
  created_at: new Date().toISOString(),
  engine_baseline:
    "Safari 27+ / JSPI-capable V8 (old system JSC does not determine current Safari support)",
  machine: {
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    cpu: os.cpus()[0]?.model,
  },
  versions: {
    node: process.version,
    v8: process.versions.v8,
    rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
    binaryen: 133,
    wit_bindgen: "0.58.0",
    wit_parser: "0.251.0",
    jco_wasm_exnref_enabled: true,
    jco: "1.39.0",
    wasm_tools: execFileSync("wasm-tools", ["--version"], {
      encoding: "utf8",
    }).trim(),
  },
  method: {
    naming:
      "taraba namespace after rename; differences from former-name snapshots may include symbol/path changes, not algorithm optimizations",
    algorithm: "experiments/wit/shared/compute.rs (same source)",
    rustflags:
      "-C link-arg=-zstack-size=65536 -C link-arg=--max-memory=1048576",
    cold_build:
      "one empty CARGO_TARGET_DIR per profile; dependencies cached/offline, tool install excluded",
    warm_build: "three unchanged cargo builds",
    optimization:
      "same Binaryen 133 Oz + flatten + rereloop + Oz + converge; Component guest before componentization",
    compression:
      "each deployable JS/Wasm file independently compressed; sum, no type declarations",
    scope:
      "3507 signed-i32 tasks + matching two host calls + two externally controlled suspensions; JS identity/rejection/cancellation/fatal contracts are not common WIT async guarantees",
    timing:
      "sequential, per-instance warmup 4096 tasks; 11 samples of 4096 tasks, 512 concurrent; includes native Promise and host import overhead",
  },
  profiles: [],
};
for (const mode of ["no_std", "std"])
  for (const backend of ["jspi", "core", "component-sync", "component"]) {
    const id = `${backend}-${mode}`,
      dir = `${out}/${id}`,
      target = `${out}/target-${id}`;
    mkdirSync(dir, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    const manifest = `experiments/wit/${backend}/Cargo.toml`;
    // just compare-wit fetches the committed lockfiles before timing.
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: target,
      RUSTFLAGS: report.method.rustflags,
    };
    const args = [
      "build",
      "--locked",
      "--offline",
      "--manifest-path",
      manifest,
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      ...(mode === "std" ? ["--features", "std"] : []),
    ];
    const cold = run("cargo", args, { env }),
      warm = Array.from({ length: 3 }, () => run("cargo", args, { env }));
    const raw = `${target}/wasm32-unknown-unknown/release/wit_${backend.replaceAll("-", "_")}.wasm`;
    let transform;
    if (backend === "core" || backend === "jspi")
      transform = run("./target/release/taraba", [
        "build",
        raw,
        "--wit",
        `experiments/wit/${backend}/wit`,
        "--out-dir",
        dir,
        "--binaryen",
        binaryen,
        ...(backend === "jspi" ? ["--jspi"] : ["--future"]),
      ]);
    else {
      const t = performance.now();
      run(`${binaryen}/wasm-opt`, [
        raw,
        ...optimizationArgs("Oz"),
        "--flatten",
        "--rereloop",
        "-Oz",
        "--converge",
        "-o",
        `${dir}/guest.wasm`,
      ]);
      run("wasm-tools", [
        "component",
        "new",
        `${dir}/guest.wasm`,
        "-o",
        `${dir}/app.component.wasm`,
      ]);
      run("pnpm", [
        "exec",
        "jco",
        "transpile",
        `${dir}/app.component.wasm`,
        "--name",
        "app",
        "--instantiation",
        "async",
        "--async-mode",
        "jspi",
        "--async-imports",
        backend === "component-sync"
          ? "taraba:experiment/host@0.1.0#add"
          : "add",
        "--async-exports",
        "run",
        "--no-wasi-shim",
        "--no-nodejs-compat",
        "--minify",
        "--bindgen-enable-wasm-exnref",
        "--base64-cutoff",
        "0",
        "-o",
        `${dir}/js`,
      ]);
      // A final identical JS minifier policy for both deployment paths.
      const js = await esbuild.transform(
        readFileSync(`${dir}/js/app.js`, "utf8"),
        { minify: true, target: "es2022", format: "esm" },
      );
      writeFileSync(`${dir}/js/app.mjs`, js.code);
      transform = performance.now() - t;
    }
    const files =
      backend === "core" || backend === "jspi"
        ? [`${dir}/app.wasm`, `${dir}/taraba.mjs`]
        : readdirSync(`${dir}/js`)
            .filter((f) => f.endsWith(".wasm") || f === "app.mjs")
            .map((f) => `${dir}/js/${f}`);
    const sizes = files.map((f) => {
      const b = readFileSync(f);
      const { gzip, brotli } = artifactSizes(b);
      return {
        file: f.slice(dir.length + 1),
        bytes: b.length,
        gzip,
        brotli,
        sha256: createHash("sha256").update(b).digest("hex"),
      };
    });
    const jsBytes = sizes
        .filter((s) => s.file.endsWith(".mjs"))
        .reduce((n, s) => n + s.bytes, 0),
      wasmBytes = sizes
        .filter((s) => s.file.endsWith(".wasm"))
        .reduce((n, s) => n + s.bytes, 0);
    const profile = {
      id,
      backend,
      mode,
      cold_build_ms: cold,
      warm_build_ms: warm,
      transform_ms: transform,
      raw_wasm_bytes: readFileSync(raw).length,
      component_container_bytes: backend.startsWith("component")
        ? readFileSync(`${dir}/app.component.wasm`).length
        : null,
      wasm_bytes: wasmBytes,
      js_bytes: jsBytes,
      total_bytes: jsBytes + wasmBytes,
      gzip_bytes: sizes.reduce((n, s) => n + s.gzip, 0),
      brotli_bytes: sizes.reduce((n, s) => n + s.brotli, 0),
      files: sizes,
    };
    report.profiles.push(profile);
    console.log(
      `${id}: Wasm ${wasmBytes}, JS ${jsBytes}, total ${profile.total_bytes} B, build ${cold.toFixed(0)} ms`,
    );
  }
// All compile/transpile work completes before runtime timing.
for (const profile of report.profiles) {
  const dir = `${out}/${profile.id}`;
  let factory;
  if (profile.backend === "core" || profile.backend === "jspi") {
    const { instantiate } = await import(pathToFileURL(`${dir}/taraba.mjs`));
    const module = new WebAssembly.Module(readFileSync(`${dir}/app.wasm`));
    factory = async (add) => {
      const host = await instantiate(module, { bindings: { add } });
      return (...args) => host.promise("run", ...args);
    };
  } else {
    const { instantiate } = await import(pathToFileURL(`${dir}/js/app.mjs`));
    const modules = Object.fromEntries(
      profile.files
        .filter((f) => f.file.endsWith(".wasm"))
        .map((f) => [
          f.file.slice(3),
          new WebAssembly.Module(readFileSync(`${dir}/${f.file}`)),
        ]),
    );
    factory = async (add) => {
      const api = await instantiate(
        (name) => modules[name],
        profile.backend === "component-sync"
          ? { "taraba:experiment/host": { add } }
          : { add: { default: add } },
      );
      return api.run;
    };
  }
  profile.v8 = await verifyWit(factory, cases);
  profile.v8_timing = await timeWit(factory, () => performance.now());
  const jsc =
    "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";
  if (existsSync(jsc)) {
    const mods = Object.fromEntries(
      profile.files
        .filter((f) => f.file.endsWith(".wasm"))
        .map((f) => [
          profile.backend.startsWith("component") ? f.file.slice(3) : f.file,
          Array.from(readFileSync(`${dir}/${f.file}`)),
        ]),
    );
    const importPath = !profile.backend.startsWith("component")
      ? `${dir}/taraba.mjs`
      : `${dir}/js/app.mjs`;
    const factorySource = !profile.backend.startsWith("component")
      ? `async add=>{const h=await instantiate(modules['app.wasm'],{bindings:{add}});return (...a)=>h.promise('run',...a)}`
      : `async add=>{const a=await instantiate(name=>modules[name],${profile.backend === "component-sync" ? '{"taraba:experiment/host":{add}}' : "{add:{default:add}}"});return a.run}`;
    const source = `import {instantiate} from ${JSON.stringify(importPath)};import {verifyWit} from ${JSON.stringify(resolve("tests/support/wit-contract.mjs"))};const bytes=${JSON.stringify(mods)};const modules=Object.fromEntries(Object.entries(bytes).map(([n,b])=>[n,new WebAssembly.Module(new Uint8Array(b))]));verifyWit(${factorySource},${JSON.stringify(cases)}).then(result=>print(JSON.stringify({supported:true,result})),e=>print(JSON.stringify({supported:false,error:String(e),promising:typeof WebAssembly.promising,suspending:typeof WebAssembly.Suspending})));`;
    const bundle = await esbuild.build({
      stdin: { contents: source, resolveDir: root },
      bundle: true,
      format: "iife",
      platform: "neutral",
      write: false,
      target: "es2022",
      define: {
        "import.meta.url": JSON.stringify(pathToFileURL(importPath).href),
      },
    });
    writeFileSync(
      `${dir}/jsc.js`,
      "globalThis.queueMicrotask=fn=>{Promise.resolve().then(fn);};\n" +
        bundle.outputFiles[0].text,
    );
    const result = JSON.parse(
      execFileSync(jsc, [`${dir}/jsc.js`], {
        encoding: "utf8",
        timeout: 60000,
      }).trim(),
    );
    if (
      !result.supported &&
      (result.promising !== "function" || result.suspending !== "function") &&
      profile.backend !== "core"
    ) {
      result.outside_engine_baseline = true;
      result.note = "Old system JSC, not a Safari 27 compatibility result";
    }
    profile.javascriptcore = result;
    if (!result.outside_engine_baseline) {
      assert.equal(result.supported, true);
      assert.deepEqual(result.result, profile.v8);
    }
  }
  console.log(
    `${profile.id}: common tests passed, ${profile.v8_timing.median.toFixed(3)} us/task; JSC ${profile.javascriptcore?.supported}`,
  );
}
const sources = [
  "experiments/wit/shared/compute.rs",
  ...["jspi", "core", "component-sync", "component"].flatMap((p) => [
    `experiments/wit/${p}/Cargo.toml`,
    `experiments/wit/${p}/Cargo.lock`,
    `experiments/wit/${p}/src/lib.rs`,
    `experiments/wit/${p}/wit/app.wit`,
  ]),
  "tests/support/wit-contract.mjs",
  "tests/support/async-contract.mjs",
  "tools/compare-wit.mjs",
  "tests/support/metrics.mjs",
  "Cargo.lock",
  "crates/taraba-cli/assets/provenance.json",
  ...["crates/taraba", "crates/taraba-allocator", "crates/taraba-cli"].flatMap(
    (base) =>
      readdirSync(base, { recursive: true })
        .filter(
          (p) =>
            p.endsWith(".rs") ||
            p.endsWith(".wat") ||
            p.endsWith(".mjs") ||
            p === "Cargo.toml",
        )
        .map((p) => `${base}/${p}`),
  ),
];
report.inputs = Object.fromEntries(
  sources.map((f) => [
    f,
    createHash("sha256").update(readFileSync(f)).digest("hex"),
  ]),
);
report.decision = {
  engine_baseline: "Safari 27+ / JSPI-capable V8; JSPI is available by design",
  small_profile:
    "Direct scalar WIT/Core JSPI (default; --jspi is an explicit alias)",
  future_profile:
    "Optional --future Core runtime for spawn_local/cancel and concurrent Rust Futures; retained pending JSPI adoption gates",
  component_profiles:
    "Both synchronous WIT + JSPI and native WIT async + jco are retained for comparison",
  contracts:
    "JSPI scalar serializes guest entry, treats rejection/trap as fatal, and does not provide cancellation or arbitrary Future execution; common success tests are not full runtime equivalence",
  safari_verification:
    "Official Safari 27 JSPI support confirmed; this run uses Node V8 and an old system JSC, not a Safari 27 browser",
};
mkdirSync("docs", { recursive: true });
writeFileSync(
  "docs/wit-comparison.json",
  JSON.stringify(report, null, 2) + "\n",
);
const rows = report.profiles
  .map(
    (p) =>
      `| ${p.id} | ${p.wasm_bytes.toLocaleString("en-US")} | ${p.js_bytes.toLocaleString("en-US")} | ${p.total_bytes.toLocaleString("en-US")} | ${p.gzip_bytes.toLocaleString("en-US")} | ${(p.cold_build_ms / 1000).toFixed(2)} s | ${p.v8_timing.median.toFixed(3)} | ${p.javascriptcore?.supported ? "通過" : "旧 JSC: 前提外"} |`,
  )
  .join("\n");
writeFileSync(
  "docs/wit-comparison.md",
  `# WIT / JSPI 比較実験

${report.created_at}

実験環境の前提は **Safari 27+ / JSPI 対応 V8**。[WebKit 公式](https://webkit.org/blog/18325/webkit-features-for-safari-27-0/#webassembly)で Safari 27 の JSPI 対応を確認した。旧 system JSC の未対応を最新 Safari の非対応とは扱わない。Safari 27 実ブラウザーはこの測定では未検証。

同じ [二段 await](../experiments/wit/shared/compute.rs) をコンパイルし、全構成で符号付き i32 の共通 3,507 ケース、全 host I/O、外から解決する二回の待機を通した。JSPI の Rust デモは同期 import 内でエンジンが待機し、同じ Future の poll は Ready を返す。任意の Pending Future の executor ではない。

| 構成 | Wasm B | JS B | 合計 B | gzip 合計 B | cold build | V8 μs/task 中央値 | system JSC |
|---|---:|---:|---:|---:|---:|---:|---|
${rows}

jspi は直接 Core JSPI、core は従来の Future 構成、component-sync は同期 WIT + jco JSPI、component は WIT native async + jco JSPI。サイズは実際に配信する全 Wasm と loader を含む JS の合計。Component container を展開後ファイルと二重計上せず、型宣言は除外。圧縮はファイルごとに適用。

全構成で Binaryen 133、Oz / flatten / rereloop / converge、64 KiB stack、1 MiB memory 上限、同じ allocator（size classes 無効）。JS は esbuild minify を適用。直接 JSPI は Rust task pool を持たず、不要な canonical realloc とメタデータを除去する。Rust/JS ともアプリを含むサイズであり、機能が同一なランタイムの固定費ではない。

ビルドは各構成の空の CARGO_TARGET_DIR 一回、依存取得後・offline。Rust build と変換工程は別計時で、warm build 三回も JSON に保存する。ツールのインストール時間は除外。実行は V8 上で 512 呼び出しを投入し、4,096 タスクずつ 11 回。直接 JSPI は投入された呼び出しを instance 内で直列実行する。ビルドと性能測定は同時実行しない。

速度は JSPI / Promise / host I/O / scheduler 込み。WIT native async の jco scheduler は setTimeout（10 ms）を使う経路を含むため、値を Wasm 命令自体や Component Model 全体の速度差とは解釈しない。

採用方針: JSPI を既定の実行基盤とし（**--jspi** でも明示可能）、既存 Future 構成は **--future** で選ぶ。これは guest entry の直列化と reject / trap 時の first-fatal を契約とする。spawn_local / cancel / 一般的な Rust Future を使う場合は **--future** を選ぶ。JSPI 上の Future アダプターは実験扱いを維持する。削除条件は [採用方針](jspi-adoption.md)を参照。JS オブジェクト同一性、reject、cancel、fatal の契約の同等性は共通計算テストの範囲に含めない。Core lowering は Component Model Canonical ABI とは異なる。

実製品の JSPI 検証は \`just check\` と \`just package-check\`。release/debug × std/no_std で同じ入力と実 Rust stack spill、crate 外の consumer を確認する。測定再実行は \`just compare-wit\`。バージョン、全サンプル、各ファイルと入力のハッシュは [JSON](wit-comparison.json)。
`,
);
console.log("wrote docs/wit-comparison.{json,md}");
