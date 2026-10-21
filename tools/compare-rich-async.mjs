import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import os from "node:os";
import { rolldown } from "rolldown";
import { artifactSizes } from "../tests/support/metrics.mjs";
import {
  input,
  expected,
  transform,
  verify,
} from "../experiments/rich-async/contract.mjs";
import { verifySizeBudget } from "../experiments/rich-async/metrics.mjs";
import { markdown } from "../experiments/rich-async/report.mjs";
const root = resolve("."),
  out = resolve(".cache/rich-async"),
  cli = resolve("target/release/taraba");
mkdirSync(out, { recursive: true });
const platform = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "macos" : process.platform}`;
const env = {
  ...process.env,
  CARGO_TARGET_DIR: join(out, "target"),
  TARABA_BINDGEN: cli,
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  RUSTFLAGS: "-C link-arg=-zstack-size=65536 -C link-arg=--max-memory=67108864",
};
const run = (bin, args) =>
  execFileSync(bin, args, {
    cwd: root,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
let instance = 0;
async function compile(backend, std, measured) {
  const features = [
    backend === "taraba" ? "core-runtime" : "component",
    ...(std ? ["std"] : []),
    ...(measured ? ["measured"] : []),
  ];
  run("cargo", [
    "build",
    "--locked",
    "--manifest-path",
    "experiments/rich-async/Cargo.toml",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--no-default-features",
    "--features",
    features.join(","),
  ]);
  const folder = join(
    out,
    `${backend}-${std ? "std" : "no_std"}${measured ? "-measured" : ""}`,
  );
  run(cli, [
    "build",
    join(
      env.CARGO_TARGET_DIR,
      "wasm32-unknown-unknown/release/rich_async.wasm",
    ),
    "--wit",
    "experiments/rich-async/wit",
    "--world",
    measured ? "measured" : "app",
    "--out-dir",
    folder,
    "--npm-name",
    `@bench/${backend}`,
    ...(backend === "wit-bindgen"
      ? [
          "--component",
          "--wasm-tools",
          resolve(
            `.cache/toolchains/wasm-tools-1.245.1-${platform}/wasm-tools`,
          ),
          "--jco",
          resolve("node_modules/.bin/jco"),
        ]
      : []),
  ]);
  const bundle = await rolldown({
    input: join(folder, "index.js"),
    platform: "neutral",
    transform: { target: "es2022" },
  });
  let generated;
  try {
    generated = await bundle.generate({ format: "esm", minify: true });
  } finally {
    await bundle.close();
  }
  assert.equal(generated.output.length, 1);
  writeFileSync(join(folder, "bundle.mjs"), generated.output[0].code);
  return {
    folder,
    factory: async (callback, observe = null) => {
      const module = await import(
        `${pathToFileURL(join(folder, "bundle.mjs")).href}?instance=${instance++}`
      );
      if (backend === "taraba") {
        const host = module.createHost({ bindings: { transform: callback } });
        host.attach(
          (
            await WebAssembly.instantiate(
              readFileSync(join(folder, "app.wasm")),
              host.imports,
            )
          ).instance.exports,
        );
        return {
          run: host.process,
          live: host["heap-live"],
          peak: host["heap-peak"],
          reset: host["heap-reset"],
          linear: host["linear-bytes"],
        };
      }
      const memories = [];
      const instantiateCore = observe
        ? (module, imports) => {
            const instance = new WebAssembly.Instance(module, imports);
            const exports = { ...instance.exports };
            if (exports.memory) memories.push(exports.memory);
            for (const name of Object.keys(exports))
              if (name.startsWith("cabi_realloc")) {
                const realloc = exports[name];
                exports[name] = (...args) => {
                  observe.realloc_calls++;
                  if (args[3] === 0) observe.zero_size_realloc_calls++;
                  return realloc(...args);
                };
              }
            return { exports };
          }
        : undefined;
      const api = await module.instantiate(
        (name) => new WebAssembly.Module(readFileSync(join(folder, name))),
        {
          transform: {
            default: async (value) => {
              const r = await callback(value);
              if (r.tag === "err") throw r.val;
              return r.val;
            },
          },
        },
        instantiateCore,
      );
      return {
        run: async (value) => {
          try {
            return { tag: "ok", val: await api.process(value) };
          } catch (e) {
            assert.equal(
              typeof e.payload,
              "string",
              "unexpected Component trap",
            );
            return { tag: "err", val: e.payload };
          }
        },
        sharesMemory: (value) =>
          memories.some((m) => value.payload.buffer === m.buffer),
        live: api.heapLive,
        peak: api.heapPeak,
        reset: api.heapReset,
        linear: api.linearBytes,
      };
    },
  };
}
async function benchmark(factory) {
  const api = await factory(async (v) => {
      await Promise.resolve();
      return transform(v);
    }),
    results = [];
  for (const size of [32, 1024])
    for (const concurrency of [1, 16]) {
      const values = Array.from({ length: concurrency }, (_, i) =>
        input(i + 1, size),
      );
      for (let i = 0; i < 30; i++)
        await Promise.all(values.map((v) => api.run(v)));
      const samples = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        for (let j = 0; j < 20; j++)
          await Promise.all(values.map((v) => api.run(v)));
        samples.push(((performance.now() - start) * 1000) / (20 * concurrency));
      }
      samples.sort((a, b) => a - b);
      results.push({
        payload_bytes: size,
        concurrency,
        median_us_per_call: samples[3],
        min_us_per_call: samples[0],
        max_us_per_call: samples[6],
        samples: 7,
        calls_per_sample: 20 * concurrency,
      });
    }
  return results;
}
async function quiesce() {
  // Canonical async post-return work may be scheduled after the exported
  // Promise settles. Give both schedulers the same event-loop turns.
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
  }
}
async function memory(factory) {
  const api = await factory(async (v) => {
      await Promise.resolve();
      return transform(v);
    }),
    initial_linear_bytes = await api.linear(),
    results = [];
  for (const [size, concurrency] of [
    [32, 1],
    [1024, 16],
    [1024, 128],
  ]) {
    await quiesce();
    const before = await api.live();
    await api.reset();
    const values = Array.from({ length: concurrency }, (_, i) =>
      input(i + 1, size),
    );
    assert.deepEqual(
      await Promise.all(values.map((v) => api.run(v))),
      values.map(expected),
    );
    await quiesce();
    const after = await api.live();
    // Standard async Canonical ABI retains some scheduler/canonical state at rest;
    // report it rather than claiming both schedulers have identical ownership.
    results.push({
      payload_bytes: size,
      concurrency,
      initial_requested_heap_bytes: before,
      peak_requested_heap_bytes: await api.peak(),
      after_requested_heap_bytes: after,
      linear_bytes: await api.linear(),
    });
  }
  const observation = { realloc_calls: 0, zero_size_realloc_calls: 0 };
  const probe = await factory(
      async (value) => ({ tag: "ok", val: value }),
      observation,
    ),
    retention = [];
  let sharedOutput = false;
  for (let i = 0; i < 3; i++) {
    const value = await probe.run(input(i + 1, 32, "abc"));
    sharedOutput ||= probe.sharesMemory?.(value.val) ?? false;
    await quiesce();
    retention.push(await probe.live());
  }
  return {
    initial_linear_bytes,
    measurements: results,
    retention_probe: {
      requested_heap_after_each_call: retention,
      output_shares_guest_memory: sharedOutput,
      ...observation,
    },
  };
}
const entries = [];
try {
  for (const std of [false, true])
    for (const backend of ["taraba", "wit-bindgen"]) {
      const app = await compile(backend, std, false),
        verified = await verify(app.factory),
        performance = await benchmark(app.factory);
      const measured = await compile(backend, std, true);
      await verify(measured.factory);
      const heap = await memory(measured.factory);
      const artifacts = [
        "bundle.mjs",
        ...readdirSync(app.folder).filter(
          (f) => f.endsWith(".wasm") && f !== "app.component.wasm",
        ),
      ].map((path) => {
        const bytes = readFileSync(join(app.folder, path));
        return {
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          ...artifactSizes(bytes),
        };
      });
      const wasm_bytes = artifacts
          .filter((f) => f.path.endsWith(".wasm"))
          .reduce((n, f) => n + f.raw, 0),
        js_bytes = artifacts.find((f) => f.path === "bundle.mjs").raw;
      entries.push({
        backend,
        mode: std ? "std" : "no_std",
        wasm_bytes,
        js_bytes,
        total_bytes: wasm_bytes + js_bytes,
        component_container_bytes:
          backend === "wit-bindgen"
            ? readFileSync(join(app.folder, "app.component.wasm")).length
            : 0,
        verified,
        performance,
        memory: heap,
        artifacts,
      });
      console.log(
        `${backend}/${std ? "std" : "no_std"}: ${wasm_bytes} B Wasm + ${js_bytes} B JS, ${verified.cases} shared cases; timings and memory measured`,
      );
    }
  const report = {
    schema: 1,
    engine_flags: process.execArgv,
    created_at: new Date().toISOString(),
    engine: `Node ${process.version} / V8 ${process.versions.v8}`,
    machine: { cpu: os.cpus()[0]?.model, arch: process.arch, os: os.release() },
    rust: run("rustc", ["--version"]).toString().trim(),
    versions: {
      wit_bindgen: "0.58.0 (macros/async; no async-spawn)",
      jco: "1.39.0",
      binaryen: 133,
    },
    methodology: {
      algorithm:
        "One shared Rust workflow: record {id:u32,label:string,payload:list<u8>}; two async host transforms; UTF-8 string/bytes copies; wrapping byte arithmetic; result<packet,string>. Domain errors are normalized by the test harness.",
      sizes:
        "Optimized release -Oz, LTO, one codegen unit, same taraba allocator with default features disabled. Rollup-style single minified ESM by Rolldown. All deployed core Wasm + JS counted; Component container and declarations excluded from runtime total.",
      performance:
        "Non-instrumented artifacts; 30 warmup batches, 7 samples of 20 batches. Same host Promise microtask. --no-liftoff recommended; timings are local observations, not universal guarantees.",
      memory:
        "Separate measured binaries with identical counting allocator wrappers. Four timer/immediate turns before/after each batch drain deferred post-return work. Peak requested Rust heap bytes excludes allocator metadata, fragmentation, JS heap, and static storage. Linear bytes includes static pool, stack and reserved pages; monotone Wasm high-water mark. Instrumentation is excluded from reported size/timing.",
      host: "Both run on the same Node/V8. Component uses standard Canonical ABI / JSPI via jco; Core uses private Promise ABI. Not a Wasmtime/WASI comparison.",
      safari_browser_verified: false,
    },
    entries,
    inputs: Object.fromEntries(
      [
        "experiments/rich-async/Cargo.toml",
        "experiments/rich-async/Cargo.lock",
        "experiments/rich-async/build.rs",
        "experiments/rich-async/wit/app.wit",
        "experiments/rich-async/src/lib.rs",
        "experiments/rich-async/src/workflow.rs",
        "experiments/rich-async/src/measured.rs",
        "experiments/rich-async/contract.mjs",
        "experiments/rich-async/report.mjs",
        "experiments/rich-async/metrics.mjs",
        "crates/taraba/src/task.rs",
        "src/host.mjs",
        "src/intrusive.wat",
        "crates/taraba-cli/assets/provenance.json",
        "crates/taraba-cli/src/bindings.rs",
        "crates/taraba-cli/src/core_async.rs",
        "crates/taraba-cli/src/core_types.rs",
        "Cargo.lock",
        "pnpm-lock.yaml",
        "tools/compare-rich-async.mjs",
      ].map((p) => [
        p,
        createHash("sha256").update(readFileSync(p)).digest("hex"),
      ]),
    ),
  };
  if (process.argv.includes("--check"))
    report.size_budget = verifySizeBudget(
      entries,
      JSON.parse(readFileSync("docs/rich-async-size.json")).entries,
    );
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (process.argv.includes("--snapshot")) {
    writeFileSync(
      "docs/rich-async-size.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    writeFileSync("docs/rich-async-size.md", markdown(report));
    writeFileSync("docs/rich-async-size.ja.md", markdown(report, true));
  }
} catch (e) {
  writeFileSync(
    join(out, "failure.log"),
    `${e.stack || e}\n${e.stdout || ""}\n${e.stderr || ""}`,
  );
  throw Error(
    "Rich async comparison failed; see .cache/rich-async/failure.log",
  );
}
