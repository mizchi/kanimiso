import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { optimizationArgs } from "./wasm-opt-contract.mjs";
import { verifyAllocator } from "../experiments/allocator/probe.mjs";
import { cases, expected } from "../experiments/allocator/contract.mjs";
const out = resolve(".cache/allocator"),
  check = process.argv.includes("--check");
mkdirSync(out, { recursive: true });
rmSync(`${out}/failure.log`, { force: true });
const env = {
  ...process.env,
  CARGO_TARGET_DIR: `${out}/target`,
  RUSTFLAGS: "-C link-arg=-zstack-size=65536 -C link-arg=--max-memory=16777216",
};
const run = (cmd, args) =>
  execFileSync(cmd, args, { env, stdio: "pipe", maxBuffer: 32 * 1024 * 1024 });
const hash = (b) => createHash("sha256").update(b).digest("hex");
const report = {
  created_at: new Date().toISOString(),
  baseline: "44bf8b09c61a53368e28821874ab874258f6b1cd",
  engine: `Node ${process.version} / V8 ${process.versions.v8}`,
  machine: { cpu: os.cpus()[0]?.model, os: os.release(), arch: process.arch },
  rust: run("rustc", ["--version"]).toString().trim(),
  rustflags: env.RUSTFLAGS,
  entries: [],
  timing:
    "V8 warm instances, 21 interleaved samples, median ns/job; JIT/instantiation excluded; guest calls batch 256 jobs; boundary is a single call. Only whole-probe passes are timed; wee_alloc fails adjacent-block reuse and is excluded.",
};
const guests = new Map();
try {
  for (const backend of ["before", "current", "wee"])
    for (const mode of ["no_std", "std"])
      for (const classes of [false, true]) {
        const id = `${backend}-${mode}-${classes ? "classes" : "small"}`;
        run("cargo", [
          "build",
          "--locked",
          "--offline",
          "--manifest-path",
          "experiments/allocator/Cargo.toml",
          "--release",
          "--target",
          "wasm32-unknown-unknown",
          "--no-default-features",
          "--features",
          [
            backend,
            ...(mode === "std" ? ["std"] : []),
            ...(classes ? ["classes"] : []),
          ].join(","),
        ]);
        const raw = readFileSync(
          `${out}/target/wasm32-unknown-unknown/release/allocator_probe.wasm`,
        );
        const original = `${out}/${id}.raw.wasm`,
          optimized = `${out}/${id}.wasm`;
        writeFileSync(original, raw);
        run(".cache/toolchains/binaryen-version_133/bin/wasm-opt", [
          original,
          ...optimizationArgs("Oz"),
          "--flatten",
          "--rereloop",
          "-Oz",
          "--converge",
          "-o",
          optimized,
        ]);
        const bytes = readFileSync(optimized),
          module = await WebAssembly.compile(bytes),
          factory = async () => new WebAssembly.Instance(module).exports;
        let verification;
        try {
          verification = await verifyAllocator(factory);
        } catch (e) {
          if (backend !== "wee") throw e;
          assert.match(String(e), /adjacent free blocks must be reusable/);
          verification = { all_passed: false, error: String(e) };
        }
        const row = {
          id,
          backend,
          mode,
          classes,
          raw_bytes: raw.length,
          wasm_bytes: bytes.length,
          sha256: hash(bytes),
          verification,
          kernels: [],
        };
        for (const c of cases) {
          if (!verification.all_passed) {
            row.kernels.push({ ...c, all_passed: false, samples: [] });
            continue;
          }
          const e = await factory();
          let checks = 0;
          for (const rounds of [0, 1, 3])
            for (const seed of [0, 1, 0x12345678, 0xffffffff])
              for (const checked of [0, 1]) {
                assert.equal(
                  e.bench_run(c.id, rounds, seed, checked) >>> 0,
                  expected(c.id, rounds, seed),
                );
                checks++;
              }
          const pages = [];
          for (let i = 0; i < 16; i++) {
            assert.equal(
              e.bench_run(c.id, c.rounds, 12345, 0) >>> 0,
              expected(c.id, c.rounds, 12345),
            );
            pages.push(e.memory.buffer.byteLength);
          }
          assert.equal(
            pages[7],
            pages[15],
            `${id}/${c.name}: warm kernel grows memory`,
          );
          guests.set(`${id}/${c.id}`, e);
          row.kernels.push({
            ...c,
            checks,
            all_passed: true,
            memory_bytes: pages[15],
            samples: [],
          });
        }
        report.entries.push(row);
        console.log(
          `${id}: ${bytes.length} B, allocator oracle ${verification.all_passed ? "passed" : "excluded: reuse regression"}`,
        );
      }
  for (const c of cases) {
    const group = report.entries
      .filter((row) => row.verification.all_passed)
      .map((row) => {
        const e = guests.get(`${row.id}/${c.id}`),
          k = row.kernels[c.id],
          oracle = expected(c.id, c.rounds, 12345);
        const batch = (n) => {
          const start = performance.now();
          for (let i = 0; i < n; i++)
            assert.equal(e.bench_run(c.id, c.rounds, 12345, 0) >>> 0, oracle);
          return performance.now() - start;
        };
        let n = 1;
        while (n < 4096 && batch(n) < 3) n *= 2;
        return { e, k, batch, n };
      });
    for (let round = 0; round < 21; round++)
      for (let offset = 0; offset < group.length; offset++) {
        const g = group[(offset + round) % group.length];
        g.k.samples.push((g.batch(g.n) * 1e6) / g.n / c.jobs);
        assert.equal(g.e.memory.buffer.byteLength, g.k.memory_bytes);
      }
    for (const g of group) {
      const ordered = g.k.samples.toSorted((a, b) => a - b);
      g.k.median_ns = ordered[10];
      g.k.p10_ns = ordered[2];
      g.k.p90_ns = ordered[18];
    }
  }
  report.inputs = Object.fromEntries(
    [
      "Cargo.lock",
      "rust-toolchain.toml",
      "tools/compare-allocator.mjs",
      "tools/prepare-allocator.mjs",
      "tools/wasm-opt-contract.mjs",
      ...readdirSync("crates/taraba-allocator", { recursive: true })
        .filter((f) => /\.(rs|toml|json)$/.test(f))
        .map((f) => `crates/taraba-allocator/${f}`),
      ...readdirSync("experiments/allocator", { recursive: true })
        .filter(
          (f) => !f.startsWith("target/") && /\.(rs|toml|lock|mjs)$/.test(f),
        )
        .map((f) => `experiments/allocator/${f}`),
    ].map((p) => [p, hash(readFileSync(p))]),
  );
  report.all_current_passed = report.entries
    .filter((e) => e.backend === "current")
    .every((e) => e.verification.all_passed);
  writeFileSync(`${out}/check.json`, JSON.stringify(report, null, 2) + "\n");
  if (process.argv.includes("--require-improvement"))
    for (const mode of ["no_std", "std"]) {
      const before = report.entries.find(
        (e) => e.backend === "before" && e.mode === mode && !e.classes,
      );
      const after = report.entries.find(
        (e) => e.backend === "current" && e.mode === mode && !e.classes,
      );
      assert(
        after.wasm_bytes < before.wasm_bytes,
        `${mode}: optimized allocator must be smaller than the unmodified baseline`,
      );
    }
  if (!check) {
    writeFileSync(
      "docs/allocator.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    const lines = [
      "# Allocator のサイズ・速度検証",
      "",
      report.created_at,
      "",
      `${report.engine}; ${report.rust}; Binaryen 133。変更前は ${report.baseline}。`,
      "",
      "同じ Rust kernel と allocator oracle を使い、同じ wasm-opt 設定で比較する。Wasm は probe・検証・計算コードを含み、allocator 単体の固定費ではない。全体の oracle に失敗した wee_alloc は同等性を満たす比較対象から除外する。以下の時間は同じ検査を通った変更前後だけを測り、wee_alloc が高速かどうかの順位は付けない。",
      "",
      "| 構成 | mode | classes | Wasm B | 全体 oracle |",
      "|---|---|---|---:|---|",
    ];
    for (const e of report.entries)
      lines.push(
        `| ${e.backend} | ${e.mode} | ${e.classes ? "on" : "off"} | ${e.wasm_bytes} | ${e.verification.all_passed ? "pass" : "隣接領域の再利用で失敗"} |`,
      );
    lines.push(
      "",
      "21回の測定順を循環させた中央値 ns/job。JIT・instance 生成は除外し、各 sample で結果と memory plateau を確認する。JS→Wasm 呼び出しを含む V8 上の結果で、Criterion/Wasmtime の過去結果とは混ぜない。",
      "",
      "| mode / classes / kernel | 変更前 | 現在 | wee_alloc（除外） |",
      "|---|---:|---:|---:|",
    );
    for (const mode of ["no_std", "std"])
      for (const classes of [false, true])
        for (const c of cases) {
          const rows = ["before", "current", "wee"].map(
            (b) =>
              report.entries
                .find(
                  (e) =>
                    e.backend === b && e.mode === mode && e.classes === classes,
                )
                .kernels[c.id].median_ns?.toFixed(1) ?? "excluded",
          );
          lines.push(
            `| ${mode} / ${classes ? "on" : "off"} / ${c.name} | ${rows.join(" | ")} |`,
          );
        }
    lines.push(
      "",
      "全 sample、入力 SHA、Wasm SHA、再利用・OOM・realloc の結果は [JSON](allocator.json)。",
      "",
      "```sh",
      "just compare-allocator   # rebuild, verify, benchmark, update docs",
      "just check-allocator     # same checks; .cache only",
      "```",
      "",
    );
    writeFileSync("docs/allocator.md", lines.join("\n"));
  }
} catch (e) {
  writeFileSync(`${out}/failure.log`, `${e.stack}\n${e.stderr || ""}`);
  throw e;
}
