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
  for (const backend of ["core", "component"]) {
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
    const raw = `${target}/wasm32-unknown-unknown/release/wit_${backend}.wasm`;
    let transform;
    if (backend === "core")
      transform = run("./target/release/kanimiso", [
        "build",
        raw,
        "--wit",
        `experiments/wit/core/wit`,
        "--out-dir",
        dir,
        "--binaryen",
        binaryen,
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
        "add",
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
      backend === "core"
        ? [`${dir}/app.wasm`, `${dir}/kanimiso.mjs`]
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
      component_container_bytes:
        backend === "component"
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
  if (profile.backend === "core") {
    const { instantiate } = await import(pathToFileURL(`${dir}/kanimiso.mjs`));
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
      const api = await instantiate((name) => modules[name], {
        add: { default: add },
      });
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
          profile.backend === "component" ? f.file.slice(3) : f.file,
          Array.from(readFileSync(`${dir}/${f.file}`)),
        ]),
    );
    const importPath =
      profile.backend === "core" ? `${dir}/kanimiso.mjs` : `${dir}/js/app.mjs`;
    const factorySource =
      profile.backend === "core"
        ? `async add=>{const h=await instantiate(modules['app.wasm'],{bindings:{add}});return (...a)=>h.promise('run',...a)}`
        : `async add=>{const a=await instantiate(name=>modules[name],{add:{default:add}});return a.run}`;
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
    profile.javascriptcore = result;
    if (profile.backend === "core") {
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
  ...["core", "component"].flatMap((p) => [
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
  ...[
    "crates/kanimiso",
    "crates/kanimiso-allocator",
    "crates/kanimiso-cli",
  ].flatMap((base) =>
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
  default:
    "WIT + wit-bindgen synchronous resource bindings + kanimiso Core externref lowering",
  reason:
    "smaller combined JS/Wasm and successful common tests on both local V8 and JavaScriptCore; native Component async via jco JSPI remains an experiment",
  compatibility:
    "Core profile uses JS-root ownership, NOT the Component canonical resource ABI. Standard Component async needs JSPI here. System JavaScriptCore is not a Safari browser test.",
};
mkdirSync("docs", { recursive: true });
writeFileSync(
  "docs/wit-comparison.json",
  JSON.stringify(report, null, 2) + "\n",
);
const rows = report.profiles
  .map(
    (p) =>
      `| ${p.id} | ${p.wasm_bytes.toLocaleString("en-US")} | ${p.js_bytes.toLocaleString("en-US")} | ${p.total_bytes.toLocaleString("en-US")} | ${p.gzip_bytes.toLocaleString("en-US")} | ${(p.cold_build_ms / 1000).toFixed(2)} s | ${p.v8_timing.median.toFixed(3)} | ${p.javascriptcore?.supported ? "通過" : "JSPI API 不足で失敗"} |`,
  )
  .join("\n");
writeFileSync(
  "docs/wit-comparison.md",
  `# WIT / async ABI 比較実験\n\n${report.created_at}\n\n同じ [二段 await](../experiments/wit/shared/compute.rs) を異なるランタイムにコンパイルした。両者で 3,507 件の符号付き i32 計算と全 host I/O、外から解決する二回の待機を共通テストで確認。WIT の型は Core 版が opaque Promise resource、Component 版が async s32。JS オブジェクトの同一性、reject、cancel、fatal の契約は共通ではなく、この比較の同等性の範囲に含めない。\n\n| 構成 | Wasm B | JS B | 合計 B | gzip 合計 B | cold build | V8 μs/task 中央値 | system JSC |\n|---|---:|---:|---:|---:|---:|---:|---|\n${rows}\n\nWasm は配信する全モジュール、JS は loader を含む配信 ESM。Component container と展開後モジュールを二重計上せず、型宣言は除外。圧縮はファイルごとに適用して合計。Component の生成 JS には最終 esbuild minify も適用した。Core の JS は同じ esbuild で生成。両者とも Binaryen 133、Oz / flatten / rereloop / converge、64 KiB stack、1 MiB memory 上限、同じ allocator（size classes 無効）。\n\nビルドは各構成の空の CARGO_TARGET_DIR 一回、依存ダウンロード済み・offline、Rust と変換工程は別計時。warm build は変更なし三回を JSON に保存。CLI / jco / Binaryen 自体のインストール時間は除外。実行時間は V8 上で 512 同時実行、二段 host await を 4,096 タスクずつ 11 回。ウォームアップ後の中央値で、Rust 計算だけの速度ではない。jco の生成 scheduler は setTimeout（10 ms）で再開する経路を含むため、この差を Wasm 命令自体や Component Model 全体の速度差とは解釈しない。ビルドと性能測定は同時実行しない。\n\n採用: 公開契約は WIT、Rust の型と Guest/imports は公式 wit-bindgen で生成し、既定の実行形式は軽量 Core Wasm とする。WIT のアプリ境界を JS root と externref に lowering し、実行時の Promise scheduler・固定 pool は kanimiso が実装する。標準 Component の Canonical ABI と互換だとは扱わない。Component native async は jco JSPI の実験として残す。system JavaScriptCore では実際の生成物が JSPI API 不足で失敗した。Safari 実ブラウザーの通過は未確認。\n\n再実行: \`just compare-wit\`。バージョン、各ファイルのサイズ・ハッシュ、各計時サンプル、JSC の実エラー、入力ハッシュは [JSON](wit-comparison.json)。\n`,
);
console.log("wrote docs/wit-comparison.{json,md}");
