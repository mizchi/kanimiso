import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import os from "node:os";
import { bundleDirectHost } from "../experiments/jspi-concurrent/bundle.mjs";
import { optimizationArgs } from "./wasm-opt-contract.mjs";
import { bundleHost } from "../experiments/jspi-future/bundle.mjs";
import { verifyDriver } from "../experiments/jspi-future/verify.mjs";
import {
  verifyConcurrent,
  verifyUnsafeControl,
  verifyFutureOverlap,
} from "../experiments/jspi-concurrent/verify.mjs";
import { verifyWit, timeWitPair } from "../tests/support/wit-contract.mjs";
import { verifyScheduling } from "../tests/support/scheduling.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";
import { artifactSizes } from "../tests/support/metrics.mjs";
const checking = process.argv.includes("--check"),
  out = resolve(".cache/jspi-concurrent");
mkdirSync(out, { recursive: true });
const binaryen = resolve(".cache/toolchains/binaryen-version_133/bin");
const flags =
  "-C link-arg=-zstack-size=65536 -C link-arg=--max-memory=1048576 -C link-arg=--export=__stack_pointer -C link-arg=--export=__stack_low -C link-arg=--export=__stack_high";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const run = (bin, args, env = process.env) => {
  try {
    return execFileSync(bin, args, {
      env,
      stdio: "pipe",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    writeFileSync(`${out}/failure.log`, String(error.stderr || error));
    throw Error(`failed ${bin}; see ${out}/failure.log`);
  }
};
const cases = [1, 16, 128, 1024].flatMap(asyncCases),
  profiles = [];
const load = (file) => import(pathToFileURL(file));
for (const mode of ["no_std", "std"]) {
  for (const backend of ["jspi", "core", "bounded"]) {
    const id = `${backend === "core" ? "core-future" : `${backend}-serial`}-${mode}`,
      source = resolve(`.cache/jspi-future-experiment/${backend}-${mode}`);
    profiles.push({
      id,
      backend,
      mode,
      serialized: backend !== "core",
      concurrent: false,
      wasm: `${source}/core/app.wasm`,
      loader: `${source}/host.mjs`,
    });
  }
  for (const backend of ["jspi", "bounded"]) {
    const id = `${backend}-concurrent-${mode}`,
      dir = `${out}/${id}`;
    mkdirSync(dir, { recursive: true });
    const direct = backend === "jspi",
      manifest = direct
        ? "experiments/jspi-concurrent/Cargo.toml"
        : "experiments/jspi-future/Cargo.toml";
    const target = `${out}/target-${backend}-${mode}`,
      env = { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: flags };
    const name = direct
      ? "jspi_concurrent_experiment"
      : "jspi_future_experiment";
    const raw = `${target}/wasm32-unknown-unknown/release/${name}.wasm`;
    for (const surface of [
      "core",
      "probes",
      ...(!direct ? ["heap-probes"] : []),
    ]) {
      const probes = surface !== "core";
      const features = [
        ...(!direct ? ["bounded"] : []),
        ...(mode === "std" ? ["std"] : []),
        ...(probes ? ["probes"] : []),
        ...(surface === "heap-probes" ? ["heap-probes"] : []),
      ];
      run(
        "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "--manifest-path",
          manifest,
          "--lib",
          "--release",
          "--target",
          "wasm32-unknown-unknown",
          "--no-default-features",
          ...(features.length ? ["--features", features.join(",")] : []),
        ],
        env,
      );
      const dest = `${dir}/${surface}`;
      run("./target/release/taraba", [
        "build",
        raw,
        "--wit",
        direct
          ? "experiments/jspi-concurrent/wit"
          : "experiments/jspi-future/wit",
        "--world",
        probes
          ? direct || surface === "heap-probes"
            ? "probes"
            : "bounded-probes"
          : "app",
        "--out-dir",
        `${dest}/lowered`,
        "--binaryen",
        binaryen,
      ]);
      copyFileSync(`${dest}/lowered/app.wasm`, `${dest}/unprotected.wasm`);
      run("experiments/jspi-concurrent/target/debug/transform", [
        `${dest}/unprotected.wasm`,
        `${dest}/wrapped.wasm`,
        ...(!direct ? ["park"] : []),
      ]);
      run(`${binaryen}/wasm-opt`, [
        `${dest}/wrapped.wasm`,
        ...optimizationArgs("Oz"),
        "--flatten",
        "--rereloop",
        "-Oz",
        "--converge",
        "-o",
        `${dest}/app.wasm`,
      ]);
    }
    for (const debug of [false, true]) {
      const bytes = direct
        ? await bundleDirectHost({ debug })
        : (await bundleHost({ debug, concurrent: true })).bytes;
      writeFileSync(`${dir}/host${debug ? "-debug" : ""}.mjs`, bytes);
    }
    profiles.push({
      id,
      backend,
      mode,
      serialized: false,
      concurrent: true,
      wasm: `${dir}/core/app.wasm`,
      probes: `${dir}/probes/app.wasm`,
      ...(!direct ? { heapProbes: `${dir}/heap-probes/app.wasm` } : {}),
      unprotected: `${dir}/probes/unprotected.wasm`,
      loader: `${dir}/host.mjs`,
      debugLoader: `${dir}/host-debug.mjs`,
    });
  }
}
// Compile and validate every profile before any timing is performed.
for (const p of profiles) {
  p.module = new WebAssembly.Module(readFileSync(p.wasm));
  const { instantiate } = await load(p.loader);
  p.factory = async (add) => {
    const h = await instantiate(p.module, { bindings: { add } });
    return (...args) => h.promise("run", ...args);
  };
  p.common = await verifyWit(p.factory, cases);
  p.scheduling = await verifyScheduling(p.factory, {
    serialized: p.serialized,
  });
  p.files = [p.wasm, p.loader].map((file) => ({
    file,
    bytes: readFileSync(file).length,
    sha256: sha(readFileSync(file)),
    ...artifactSizes(readFileSync(file)),
  }));
  p.wasm_bytes = p.files[0].bytes;
  p.js_bytes = p.files[1].bytes;
  p.total_bytes = p.wasm_bytes + p.js_bytes;
  if (p.concurrent) {
    p.verification_files = [
      p.probes,
      p.unprotected,
      p.debugLoader,
      ...(p.heapProbes ? [p.heapProbes] : []),
    ].map((file) => ({
      file,
      bytes: readFileSync(file).length,
      sha256: sha(readFileSync(file)),
    }));
    p.probesModule = new WebAssembly.Module(readFileSync(p.probes));
    for (const debug of [false, true]) {
      const { instantiate: open } = await load(
        debug ? p.debugLoader : p.loader,
      );
      if (p.backend === "jspi") {
        const result = await verifyConcurrent(open, p.probesModule);
        p[debug ? "debug_probes" : "release_probes"] = result;
      } else {
        p[debug ? "debug_probes" : "release_probes"] = await verifyDriver(
          open,
          readFileSync(p.probes),
          { bounded: true, unordered: false, debug, concurrent: true },
        );
        const heap = new WebAssembly.Module(readFileSync(p.heapProbes));
        p[debug ? "debug_heap_probes" : "release_heap_probes"] =
          await verifyDriver(open, heap, {
            bounded: true,
            unordered: true,
            debug,
            concurrent: true,
          });
        p[debug ? "debug_overlap" : "release_overlap"] =
          await verifyFutureOverlap(open, heap);
      }
    }
    if (p.backend === "jspi")
      p.red_control = await verifyUnsafeControl(readFileSync(p.unprotected));
    const { instantiate: debugOpen } = await load(p.debugLoader);
    const requests = [];
    const host = await debugOpen(p.probesModule, {
      bindings: {
        add: (a, b) =>
          new Promise((resolve) => requests.push({ a, b, resolve })),
      },
    });
    const jobs = Array.from({ length: 32 }, (_, i) =>
      host.promise(p.backend === "jspi" ? "hold" : "held", i, 10),
    );
    for (let i = 0; i < 200; i++) await Promise.resolve();
    assert.equal(requests.length, 32);
    p.parked_spills = {
      task_count: 32,
      rust_array_bytes: p.backend === "jspi" ? 512 : 1024,
      stats: host.stats(),
    };
    for (const request of requests)
      request.resolve((request.a + request.b) | 0);
    assert.ok((await Promise.all(jobs)).every((v, i) => v === 2 * i + 10));
    const stats = host.stats(),
      stack = p.backend === "jspi" ? stats : stats.stack;
    assert.equal(stack.roots, 0);
    assert.equal(stack.snapshot_bytes, 0);
  }
  console.log(`${p.id}: ${p.total_bytes} B; common and scheduling passed`);
}

const delayTiming = async (factory) => {
  const samples = [];
  const run = await factory(
    (a, b) =>
      new Promise((resolve) => setTimeout(() => resolve((a + b) | 0), 5)),
  );
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    const result = await Promise.all(
      Array.from({ length: 16 }, (_, n) => run(n, -n)),
    );
    assert.ok(result.every((v) => v === 1));
    if (i > 1) samples.push(performance.now() - t);
  }
  return {
    unit: "ms/batch",
    tasks: 16,
    host_delay_ms: 5,
    host_awaits_per_task: 2,
    samples,
    median: samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)],
  };
};
if (!checking) {
  for (const mode of ["no_std", "std"]) {
    const reference = profiles.find(
      (p) => p.mode === mode && p.backend === "core",
    );
    for (const p of profiles.filter(
      (p) => p.mode === mode && p.backend !== "core",
    )) {
      const pair = await timeWitPair([reference.factory, p.factory], () =>
        performance.now(),
      );
      p.paired_immediate = {
        reference: reference.id,
        reference_timing: pair[0],
        timing: pair[1],
      };
    }
  }
  for (const p of profiles) p.delayed = await delayTiming(p.factory);
  for (const p of profiles) {
    p.process_memory = [];
    for (const count of [128, 1024]) {
      const samples = Array.from({ length: 3 }, () =>
        JSON.parse(
          run(process.execPath, [
            "--expose-gc",
            "experiments/jspi-concurrent/memory.mjs",
            p.loader,
            p.wasm,
            String(count),
            String(p.serialized),
          ]),
        ),
      );
      const median = (key) =>
        samples.map((s) => s.delta[key]).toSorted((a, b) => a - b)[1];
      p.process_memory.push({
        submitted: count,
        active_io: samples[0].active_io,
        median_delta_rss: median("rss"),
        median_delta_heap_used: median("heapUsed"),
        median_delta_array_buffers: median("arrayBuffers"),
        samples,
      });
    }
  }
}
const paths = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "target" || (e.name === "Cargo.lock" && dir.endsWith("/adapter"))
      ? []
      : e.isDirectory()
        ? paths(`${dir}/${e.name}`)
        : [`${dir}/${e.name}`],
  );
const inputs = [
  ...paths("experiments/jspi-concurrent"),
  ...paths("experiments/jspi-future"),
  ...paths("experiments/wit/core"),
  ...paths("experiments/wit/jspi"),
  ...paths("crates").filter(
    (p) => p.endsWith(".rs") || p.endsWith("Cargo.toml"),
  ),
  "Cargo.lock",
  "rust-toolchain.toml",
  "package.json",
  "pnpm-lock.yaml",
  "experiments/wit/shared/compute.rs",
  "tests/support/scheduling.mjs",
  "tests/support/wit-contract.mjs",
  "tools/experiment-jspi-concurrent.mjs",
  "crates/taraba-cli/assets/provenance.json",
];
const report = {
  created_at: new Date().toISOString(),
  adopted: false,
  engine: `Node ${process.version} / V8 ${process.versions.v8}`,
  cpu: os.cpus()[0]?.model,
  rust: run("rustc", ["--version"]).toString().trim(),
  method: {
    algorithm: "experiments/wit/shared/compute.rs",
    rustflags: flags,
    binaryen: 133,
    stack_handoff:
      "synchronous Wasm import trampolines; snapshots restored after JSPI resumes, never in Promise reactions",
    memory:
      "parked_spills counts JS snapshots only; process_memory: three isolated Node --expose-gc processes per task count, 64 task warmup, GC before baseline/parked/after. RSS is coarse resident-process growth including engine/JIT pages; serial variants have one active I/O plus queued calls",
    safari: "Safari 27 real browser unverified",
    timing:
      "build/probes finish first; immediate: 512 JS submissions per batch, alternating paired 11x4096 tasks after warmup; delayed: 16 tasks, two 5ms timers, 2 warmups + 5 samples",
  },
  profiles: profiles.map(({ factory, module, probesModule, ...p }) => p),
  inputs: Object.fromEntries(
    inputs.map((file) => [file, sha(readFileSync(file))]),
  ),
  all_passed: true,
};
writeFileSync(`${out}/check.json`, JSON.stringify(report, null, 2) + "\n");
if (!checking) {
  writeFileSync(
    "docs/jspi-concurrent.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  const rows = profiles
    .map(
      (p) =>
        `| ${p.id} | ${p.wasm_bytes} | ${p.js_bytes} | ${p.total_bytes} | ${p.paired_immediate?.timing.median.toFixed(3) ?? "paired reference"} | ${p.delayed.median.toFixed(2)} |`,
    )
    .join("\n");
  const memoryRows = profiles
    .map((p) => {
      const m = p.process_memory.find((m) => m.submitted === 1024);
      return `| ${p.id} | ${m.active_io} | ${(m.median_delta_rss / 1024).toFixed(0)} | ${(m.median_delta_heap_used / 1024).toFixed(0)} | ${(m.median_delta_array_buffers / 1024).toFixed(0)} |`;
    })
    .join("\n");
  writeFileSync(
    "docs/jspi-concurrent.md",
    `# JSPI 同一インスタンス並行実行の実験

${report.created_at} / ${report.engine} / ${report.cpu}

未採用。製品の既定は引き続き直列 JSPI。全構成で同じ二段 await と3,507ケース、同じ二回の host I/O、各 scheduling 契約を確認した。

| 構成 | Wasm B | JS B | 合計 B | 即時 μs/task | 16 tasks・各二段5ms待ちの batch ms |
|---|---:|---:|---:|---:|---:|
${rows}

即時は一度に512件を投入し、各行は既存 Future と交互に測定した別のペア。直列構成はキューで順に実行し、並行構成は各 root が同時に停止しうる。対応する既存 Future の値・全サンプルは [JSON](jspi-concurrent.json) を参照。遅延は実ネットワークではなく同じ5msタイマー二段、同じ16件。ビルド・検証は計測前に完了し、同時に走らせない。

サイズは共通アプリを含む配信 Wasm＋release JS。probes の export は含めない。並行版に必要な stack bounds の export とトランポリンも含む。Rust std/no_std、Binaryen 133 の同じ最適化条件。非同期の契約や対応する型は同一ではない。

Rust の実512 B spill、4 KiB上書き、非 LIFO・同時完了・memory.grow・共有借用競合・binding 再入・最初の fatal と未完了 sibling の解放を確認。保護なしの同じ Rust では victim の stack 破損を検出した。Future アダプターでも32個の1 KiB Future、join/select・子 Waker・Drop と late completion を確認する。別の allocator 有効 probe では FuturesUnordered を含む16 root / 32 child I/O の逆順完了も確認する。その probe のサイズは最小構成に含めない。debug は snapshot の統計を含み、release は含めない。

## 停止中のプロセスメモリ

Node --expose-gc の独立プロセスを構成ごとに3回。64 task 暖機し、1,024件を投入して最初の I/O を止め、GC 後の増分の中央値を記録した。128件と全サンプル・前後の値は JSON に保存。

| 構成 | 実際に停止中の I/O | 追加 RSS KiB | 追加 JS heap KiB | 追加 ArrayBuffer KiB |
|---|---:|---:|---:|---:|
${memoryRows}

直列構成は1件の I/O と1,023件の待ち行列、並行構成は1,024件の I/O。RSS は engine / JIT / allocator のページを含む粗いプロセス増分であり、task の厳密な stack サイズではない。JSON の parked_spills は別の32 task / 512 Bまたは1 KiB Rust配列 probe での JS snapshot のみで、engine stack や他の JS heap を含めない。snapshot のコピーコストは保持する Rust stack の深さに依存する。Safari 27 実ブラウザーは未検証。root cancel / Rust Drop の強制実行は未実装。製品への採用条件は [採用方針](jspi-adoption.md)、再実行は \`just experiment-jspi-concurrent\`。
`,
  );
}
console.log(
  checking
    ? "Concurrent checks passed; benchmark reports unchanged"
    : "Wrote docs/jspi-concurrent.{md,json}",
);
