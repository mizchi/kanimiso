import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import os from "node:os";
import esbuild from "esbuild";
import { asyncCases } from "../tests/support/async-contract.mjs";
import { verifyWit, timeWit } from "../tests/support/wit-contract.mjs";
import { artifactSizes } from "../tests/support/metrics.mjs";
import { verifyDriver } from "../experiments/jspi-future/verify.mjs";
import { optimizationArgs } from "./wasm-opt-contract.mjs";
const out = resolve(".cache/jspi-future-experiment");
const checking = process.argv.includes("--check");
mkdirSync(out, { recursive: true });
const binaryen = resolve(".cache/toolchains/binaryen-version_133/bin");
const flags = "-C link-arg=-zstack-size=65536 -C link-arg=--max-memory=1048576";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const run = (bin, args, env = process.env) => {
  const start = performance.now();
  try {
    execFileSync(bin, args, {
      env,
      stdio: "pipe",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    writeFileSync(`${out}/failure.log`, String(e.stderr || e));
    throw Error(`failed ${bin}; see ${out}/failure.log`);
  }
  return performance.now() - start;
};
const cases = [1, 16, 128, 1024].flatMap(asyncCases);
const profiles = [];
for (const mode of ["no_std", "std"])
  for (const backend of ["bounded", "adapter", "jspi", "core"]) {
    const id = `${backend}-${mode}`,
      dir = `${out}/${id}`,
      target = `${out}/target-${id}`;
    mkdirSync(dir, { recursive: true });
    if (!checking) rmSync(target, { recursive: true, force: true });
    const manifest =
      backend === "adapter" || backend === "bounded"
        ? "experiments/jspi-future/Cargo.toml"
        : `experiments/wit/${backend}/Cargo.toml`;
    const env = { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: flags };
    const args = [
      "build",
      "--manifest-path",
      manifest,
      "--locked",
      "--offline",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      ...(backend === "bounded"
        ? [
            "--no-default-features",
            "--features",
            mode === "std" ? "bounded,std" : "bounded",
          ]
        : mode === "std"
          ? ["--features", "std"]
          : []),
    ];
    const cold = run("cargo", args, env),
      warm = checking
        ? []
        : Array.from({ length: 3 }, () => run("cargo", args, env));
    const name =
      backend === "adapter" || backend === "bounded"
        ? "jspi_future_experiment"
        : `wit_${backend}`;
    const raw = `${target}/wasm32-unknown-unknown/release/${name}.wasm`;
    const wit =
      backend === "adapter" || backend === "bounded"
        ? "experiments/jspi-future/wit"
        : `experiments/wit/${backend}/wit`;
    const start = performance.now();
    run("./target/release/kanimiso", [
      "build",
      raw,
      "--wit",
      wit,
      "--world",
      "app",
      "--out-dir",
      `${dir}/core`,
      "--binaryen",
      binaryen,
      ...(backend === "core" ? [] : ["--jspi"]),
    ]);
    let loader;
    if (backend === "adapter" || backend === "bounded") {
      const result = await esbuild.build({
        entryPoints: ["experiments/jspi-future/host.mjs"],
        bundle: true,
        minify: true,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        write: false,
      });
      loader = result.outputFiles[0].contents;
    } else loader = readFileSync(`${dir}/core/kanimiso.mjs`);
    writeFileSync(`${dir}/host.mjs`, loader);
    const transform = performance.now() - start;
    const files = ["core/app.wasm", "host.mjs"].map((file) => {
      const bytes = readFileSync(`${dir}/${file}`);
      return {
        file,
        bytes: bytes.length,
        ...artifactSizes(bytes),
        sha256: sha(bytes),
      };
    });
    const profile = {
      id,
      backend,
      mode,
      cold_build_ms: cold,
      warm_build_ms: warm,
      transform_ms: transform,
      files,
      wasm_bytes: files[0].bytes,
      js_bytes: files[1].bytes,
      total_bytes: files.reduce((n, f) => n + f.bytes, 0),
      gzip_bytes: files.reduce((n, f) => n + f.gzip, 0),
    };
    if (backend === "adapter" || backend === "bounded") {
      run(
        "cargo",
        [...args, "--features", mode === "std" ? "std,probes" : "probes"],
        env,
      );
      run("./target/release/kanimiso", [
        "build",
        raw,
        "--wit",
        wit,
        "--world",
        backend === "bounded" ? "bounded-probes" : "probes",
        "--out-dir",
        `${dir}/probes`,
        "--binaryen",
        binaryen,
        "--jspi",
      ]);
      profile.probes_wasm_bytes = readFileSync(`${dir}/probes/app.wasm`).length;
      if (backend === "bounded") {
        const wat = execFileSync(
          `${binaryen}/wasm-opt`,
          [
            `${dir}/core/app.wasm`,
            "--print",
            ...optimizationArgs("Oz").filter((arg) =>
              arg.startsWith("--enable-"),
            ),
          ],
          { encoding: "utf8" },
        );
        assert.ok(
          !wat.includes("memory.grow"),
          "bounded sample must not grow a heap",
        );
        profile.fixed_capacity = 16;
        profile.allocator = "trap on alloc/free; no general heap allocator";
        profile.heap_growth_instructions = false;
      }

      if (backend === "bounded") {
        run("cargo", [...args, "--features", "probes,heap-probes"], env);
        run("./target/release/kanimiso", [
          "build",
          raw,
          "--wit",
          wit,
          "--world",
          "probes",
          "--out-dir",
          `${dir}/heap-probes`,
          "--binaryen",
          binaryen,
          "--jspi",
        ]);
        profile.heap_probe_wasm_bytes = readFileSync(
          `${dir}/heap-probes/app.wasm`,
        ).length;
      }
    }
    profiles.push(profile);
    console.log(
      `${id}: Wasm ${profile.wasm_bytes} + JS ${profile.js_bytes} = ${profile.total_bytes} B`,
    );
  }
// Compile everything before timing; no builds, stress or proof tools run concurrently.
for (const profile of profiles) {
  const dir = `${out}/${profile.id}`;
  const { instantiate } = await import(pathToFileURL(`${dir}/host.mjs`));
  const module = new WebAssembly.Module(readFileSync(`${dir}/core/app.wasm`));
  const factory = async (add) => {
    const h = await instantiate(module, { bindings: { add } });
    return (...args) => h.promise("run", ...args);
  };
  profile.common = await verifyWit(factory, cases);
  if (profile.backend === "adapter" || profile.backend === "bounded")
    profile.probes = await verifyDriver(
      instantiate,
      readFileSync(`${dir}/probes/app.wasm`),
      {
        unordered: profile.backend !== "bounded",
        bounded: profile.backend === "bounded",
      },
    );
  if (profile.backend === "bounded")
    profile.heap_probes = await verifyDriver(
      instantiate,
      readFileSync(`${dir}/heap-probes/app.wasm`),
      { unordered: true, bounded: true },
    );
  if (!checking)
    profile.timing = await timeWit(factory, () => performance.now(), 11);
  assert.equal(profile.common.tasks, 3507);
  console.log(
    `${profile.id}: passed${checking ? "" : `; ${profile.timing.median.toFixed(3)} us/task`}`,
  );
}
const paths = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (
      e.name === "target" ||
      (e.name === "Cargo.lock" && dir.endsWith("/adapter"))
    )
      return [];
    const path = `${dir}/${e.name}`;
    return e.isDirectory() ? paths(path) : [path];
  });
const inputPaths = [
  ...paths("experiments/jspi-future").filter((p) => !p.endsWith(".md")),
  "experiments/wit/shared/compute.rs",
  "tools/experiment-jspi-future.mjs",
  "tools/wasm-opt-contract.mjs",
  "tests/support/wit-contract.mjs",
  "tests/support/async-contract.mjs",
  "tests/support/metrics.mjs",
  ...["core", "jspi"].flatMap((b) => paths(`experiments/wit/${b}`)),
  "src/jspi.mjs",
  "src/host.mjs",
  "src/index.mjs",
  "src/errors.mjs",
  "src/error-codes.json",
  "crates/kanimiso-cli/assets/provenance.json",
  ...paths("crates/kanimiso/src"),
  ...paths("crates/kanimiso-cli/src"),
  ...paths("crates/kanimiso-allocator/src"),
  "Cargo.lock",
  "Cargo.toml",
  "package.json",
  "pnpm-lock.yaml",
];
const report = {
  created_at: new Date().toISOString(),
  adopted: false,
  engine: `Node ${process.version} / V8 ${process.versions.v8}`,
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
  },
  rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
  versions: {
    binaryen: 133,
    wit_bindgen: "0.58.0",
    futures_util: "0.3.31",
    esbuild: esbuild.version,
  },
  method: {
    algorithm: "experiments/wit/shared/compute.rs",
    flags,
    binaryen: 133,
    optimization: "Oz / flatten / rereloop / Oz / converge",
    cold: checking
      ? "cached build; no build benchmark"
      : "empty target, cached dependencies, offline; 3 warm builds",
    timing: checking
      ? "not measured"
      : "4096 warmup, 11 samples × 4096 tasks, 512 JS submissions; bounded/adapter/direct serialize guest entry",
    contract:
      "common signed i32 arithmetic and two host requests only; no claim of identical cancellation/fatal/concurrency contracts",
    deployment:
      "core/app.wasm + host.mjs only; probe exports excluded from size comparison",
  },
  bounded_std_matches_no_std: readFileSync(
    `${out}/bounded-no_std/core/app.wasm`,
  ).equals(readFileSync(`${out}/bounded-std/core/app.wasm`)),
  profiles,
  inputs: Object.fromEntries(
    [...new Set(inputPaths)].sort().map((p) => [p, sha(readFileSync(p))]),
  ),
};
if (checking) {
  writeFileSync(
    `${out}/check.json`,
    JSON.stringify({ ...report, all_passed: true }, null, 2) + "\n",
  );
  console.log("Experimental driver checks passed; benchmark reports unchanged");
} else {
  writeFileSync(
    "docs/jspi-future-experiment.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  const rows = profiles
    .map(
      (p) =>
        `| ${p.id} | ${p.wasm_bytes.toLocaleString("en-US")} | ${p.js_bytes.toLocaleString("en-US")} | ${p.total_bytes.toLocaleString("en-US")} | ${p.gzip_bytes.toLocaleString("en-US")} | ${p.timing.median.toFixed(3)} |`,
    )
    .join("\n");
  writeFileSync(
    "docs/jspi-future-measurements.md",
    `# JSPI Future アダプター測定\n\n${report.created_at} / ${report.engine}\n\n未採用の実験。同じ二段 await と共通3,507ケース、同じ二回の host I/O・制御された二段待機を全構成で確認。std/no_std、同じ最適化条件。bounded だけは heap allocator を除去する。\n\n| 構成 | Wasm B | JS B | 合計 B | gzip B | μs/task 中央値 |\n|---|---:|---:|---:|---:|---:|\n${rows}\n\nbounded は ID Waker と stack 上の16件固定登録表を使い、alloc/free が呼ばれると trap する sentinel を置く。std/no_std の Wasm バイトは${report.bounded_std_matches_no_std ? "一致" : "不一致"}。JF1 は容量超過、JF2 は借用競合の fatal コード。adapter は従来の safe Arc Waker + Vec と JSPI park を使う。jspi は同期 import で直接待機し、core は既存の spawn_local / Rust Future 構成。アプリを含むサイズで、ランタイムの固定費ではない。probe exports は除外し、全配信対象の Wasm と minify 済み JS を計上。\n\nbounded / adapter / direct は同一 instance を直列化する。既存版と cancel / fatal / 並行性の契約は同一ではなく、速度は JS Promise と host 境界を含む。Safari 27 実ブラウザーは未検証。\n\nprobe では自己 wake、futures-util の join / select、逆順完了、loser の Drop、古い完了通知、1 KiB Future を32回、reject/trap の first-fatal を確認。bounded は16件の登録・解放と17件目の I/O 開始前の JF1 を検証。動的確保する FuturesUnordered は、同じ固定 driver に allocator を追加した heap-probes で別途通す（最小サイズには含めない）。設計と限界は [実験の説明](../experiments/jspi-future/README.md)、各サンプル・ビルド時間・SHA-256 は [JSON](jspi-future-experiment.json)。\n`,
  );
  console.log("Wrote docs/jspi-future-{experiment.json,measurements.md}");
}
