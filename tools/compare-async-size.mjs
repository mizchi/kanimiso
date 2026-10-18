import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import esbuild from "esbuild";
import { artifactSizes } from "../tests/support/metrics.mjs";
import { verifyWit } from "../tests/support/wit-contract.mjs";
import {
  inspectScheduling,
  verifyScheduling,
} from "../tests/support/scheduling.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";
import {
  verifySync,
  verifyEmbassyCapacity,
} from "../experiments/async-size/contract.mjs";
import { account, growth } from "../experiments/async-size/metrics.mjs";
import { optimizationArgs } from "./wasm-opt-contract.mjs";

const check = process.argv.includes("--check"),
  root = resolve("."),
  out = resolve(".cache/async-size");
mkdirSync(out, { recursive: true });
rmSync(join(out, "failure.log"), { force: true });
const binaryen = resolve(".cache/toolchains/binaryen-version_133/bin");
const platform = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : process.arch === "arm64" ? "unknown-linux-gnu" : "unknown-linux-musl"}`;
const wbg = resolve(
  `.cache/toolchains/wasm-bindgen-0.2.129-${platform}/wasm-bindgen`,
);
const wtPlatform = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "macos" : process.platform}`;
const wasmTools = resolve(
  `.cache/toolchains/wasm-tools-1.245.1-${wtPlatform}/wasm-tools`,
);
const env = {
  ...process.env,
  CARGO_TARGET_DIR: join(out, "target"),
  RUSTFLAGS: "-C link-arg=-zstack-size=65536 -C link-arg=--max-memory=1048576",
  TARABA_BINARYEN: binaryen,
};
const run = (bin, args, cwd = root) =>
  execFileSync(bin, args, {
    cwd,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = (dir) =>
  readdirSync(dir, { recursive: true })
    .filter(
      (f) => !f.endsWith("/") && /\.(?:mjs|js|wasm|d\.ts|d\.mts)$/.test(f),
    )
    .sort();
const batches = [1, 16, 128, 1024].flatMap((c) => asyncCases(c));
const report = {
  schema: 1,
  created_at: new Date().toISOString(),
  engine: `Node ${process.version} / V8 ${process.versions.v8}`,
  machine: { os: os.release(), cpu: os.cpus()[0]?.model, arch: process.arch },
  versions: {
    rust: run("rustc", ["--version"]).toString().trim(),
    binaryen: 133,
    wasm_bindgen: "0.2.129",
    wasm_bindgen_futures: "0.4.79",
    js_sys: "0.3.106",
    embassy_executor: "0.10.0",
    wee_alloc: "0.4.5",
    jco: "1.39.0",
    esbuild: esbuild.version,
  },
  method: {
    algorithm:
      "experiments/wit/shared/compute.rs: two sequential awaits; wrapped i32 host addition, same 3507 inputs and all actual I/O",
    rustflags: env.RUSTFLAGS,
    sync_control:
      "experiments/async-size/sync.rs: same arithmetic and host I/O, synchronous Rust; selected backend glue still included",
    optimization:
      "release z/LTO/1CGU; CLI then identical Binaryen 133 Oz/flatten/rereloop/Oz/converge on every deployed core; all required JS bundled/minified with esbuild es2022",
    runtime_size:
      "all deployed JS + all required core Wasm, independently gzip9/brotli11; no declarations or Component container double-counting",
    allocation:
      "primary rows all taraba-allocator without size classes; wee_alloc without size classes is a separate allocator control",
    scope:
      "common successful arithmetic/I/O only; JSPI serialization, canonical typed errors, and Future cancellation/Drop contracts are not equivalent",
    official_embassy:
      "platform-wasm + executor-thread; upstream links std (critical-section/std); no no_std result is claimed; JsFuture bridges host I/O and Embassy drives its static 1024-worker pool",
  },
  entries: [],
  comparisons: [],
  safari_browser_verified: false,
  native_component_host_verified: false,
};
const profiles = [
  ...["jspi", "future", "component", "bindgen"].flatMap((backend) =>
    ["no_std", "std"].map((mode) => ({ backend, mode, allocator: "taraba" })),
  ),
  { backend: "embassy", mode: "std", allocator: "taraba" },
  ...["no_std", "std"].map((mode) => ({
    backend: "bindgen",
    mode,
    allocator: "wee",
  })),
  { backend: "embassy", mode: "std", allocator: "wee" },
];
let instance = 0;
try {
  for (const p of profiles)
    for (const workload of ["sync", "async"]) {
      const async = workload === "async",
        bindgen = ["bindgen", "embassy"].includes(p.backend);
      const id = `${p.backend}-${p.mode}-${p.allocator}-${workload}`,
        dir = join(out, id),
        pkg = join(dir, "pkg");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const features = [
        ...(p.mode === "std" ? ["std"] : []),
        ...(async ? ["async-workload"] : []),
        ...(bindgen
          ? p.backend === "embassy"
            ? ["embassy"]
            : []
          : [p.backend]),
        ...(p.allocator === "wee" ? ["wee"] : []),
      ];
      run("cargo", [
        "build",
        "--locked",
        "--offline",
        "--manifest-path",
        "experiments/async-size/Cargo.toml",
        "-p",
        bindgen ? "size-bindgen" : "size-core",
        "--release",
        "--target",
        "wasm32-unknown-unknown",
        "--no-default-features",
        "--features",
        features.join(","),
      ]);
      const raw = join(
        env.CARGO_TARGET_DIR,
        "wasm32-unknown-unknown/release",
        `${bindgen ? "size_bindgen" : "size_core"}.wasm`,
      );
      const rawBytes = readFileSync(raw);
      writeFileSync(join(dir, "raw.wasm"), rawBytes);
      let entry, types;
      if (bindgen) {
        run(wbg, [
          raw,
          "--target",
          "web",
          "--out-dir",
          pkg,
          "--out-name",
          "app",
        ]);
        const snippet = files(pkg).find(
          (f) => f.startsWith("snippets/") && f.endsWith("/io.mjs"),
        );
        assert.ok(
          snippet,
          "the I/O provider must ship as part of required glue",
        );
        writeFileSync(
          join(pkg, "driver.mjs"),
          `export {initSync,run} from './app.js';\nexport {setBinding} from ${JSON.stringify("./" + snippet)};\n`,
        );
        writeFileSync(
          join(pkg, "driver.d.mts"),
          `export {initSync,run} from './app.js';\nexport function setBinding(add: (a:number,b:number)=>${async ? "Promise<number>" : "number"}): void;\n`,
        );
        entry = join(pkg, "driver.mjs");
        types = "driver.d.mts";
      } else {
        const wit = resolve(
          `experiments/async-size/core/wit/${async && p.backend === "component" ? "async" : async && p.backend === "future" ? "future" : "sync"}`,
        );
        run(resolve("target/release/taraba"), [
          "build",
          raw,
          "--wit",
          wit,
          "--out-dir",
          pkg,
          ...(p.backend === "jspi" ? [] : [`--${p.backend}`]),
          "--npm-name",
          `@taraba-bench/${p.backend}-${p.mode.replace("_", "-")}`,
          "--npm-version",
          "0.0.0",
          ...(p.backend === "component"
            ? [
                "--wasm-tools",
                wasmTools,
                "--jco",
                resolve("node_modules/.bin/jco"),
              ]
            : []),
        ]);
        entry = join(pkg, p.backend === "component" ? "app.js" : "index.mjs");
        types = p.backend === "component" ? "app.d.ts" : "index.d.mts";
      }
      const bundled = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        minify: true,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        write: false,
      });
      writeFileSync(join(pkg, "bundle.mjs"), bundled.outputFiles[0].contents);
      const wasm = files(pkg).filter(
        (f) => f.endsWith(".wasm") && f !== "app.component.wasm",
      );
      for (const file of wasm) {
        const dest = join(dir, "optimized.wasm");
        run(join(binaryen, "wasm-opt"), [
          join(pkg, file),
          ...optimizationArgs("Oz"),
          "--flatten",
          "--rereloop",
          "-Oz",
          "--converge",
          "-o",
          dest,
        ]);
        writeFileSync(join(pkg, file), readFileSync(dest));
      }
      const describe = (file) => {
        const bytes = readFileSync(join(pkg, file));
        return { path: file, sha256: hash(bytes), sizes: artifactSizes(bytes) };
      };
      const runtime = ["bundle.mjs", ...wasm].map(describe),
        declarations = files(pkg)
          .filter((f) => /\.d\.(?:ts|mts)$/.test(f))
          .map(describe);
      const container =
        p.backend === "component" ? describe("app.component.wasm") : null;
      const measured = account({ runtime, declarations, container });
      const packageFiles = [
        ...runtime,
        ...declarations,
        ...(container ? [container] : []),
      ].map((f) => f.path);
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify(
          {
            name: `@taraba-bench/${p.backend}-${p.mode.replace("_", "-")}-${p.allocator}`,
            version: "0.0.0",
            type: "module",
            license: "UNLICENSED",
            exports: { ".": { types: `./${types}`, import: "./bundle.mjs" } },
            files: packageFiles,
          },
          null,
          2,
        ),
      );
      const packDir = join(dir, "pack");
      mkdirSync(packDir);
      run("pnpm", ["pack", "--pack-destination", packDir], pkg);
      const tarball = join(
        packDir,
        readdirSync(packDir).find((f) => f.endsWith(".tgz")),
      );
      const unpacked = join(dir, "unpacked");
      mkdirSync(unpacked);
      run("tar", ["-xzf", tarball, "-C", unpacked]);
      const deployed = join(unpacked, "package");
      for (const f of [
        ...runtime,
        ...declarations,
        ...(container ? [container] : []),
      ]) {
        assert.equal(
          hash(readFileSync(join(deployed, f.path))),
          f.sha256,
          `pack omitted or changed ${f.path}`,
        );
      }
      const consumer = join(dir, "consumer");
      mkdirSync(join(consumer, "node_modules", "@taraba-bench"), {
        recursive: true,
      });
      const packageName = JSON.parse(
        readFileSync(join(pkg, "package.json")),
      ).name;
      symlinkSync(deployed, join(consumer, "node_modules", packageName), "dir");
      const provider = async ? "Promise.resolve((a+b)|0)" : "(a+b)|0";
      const typing = bindgen
        ? `import {initSync,run,setBinding} from '${packageName}';\nsetBinding((a,b)=>${provider});\nconst value:number=await run(1,2);\n// @ts-expect-error invalid argument\nrun('bad',2);\n`
        : p.backend === "component"
          ? `import {instantiate} from '${packageName}';\nconst api=await instantiate(()=>new WebAssembly.Module(new Uint8Array()),{add:{default:(a,b)=>${provider}}});\nconst value:number=await api.run(1,2);\n// @ts-expect-error invalid argument\napi.run('bad',2);\n`
          : `import {instantiate} from '${packageName}';\nconst api=await instantiate(new Uint8Array(),{bindings:{add:(a,b)=>${provider}}});\nconst value:${p.backend === "future" && async ? "unknown" : "number"}=await api.exports.run(1,2);\n// @ts-expect-error invalid argument\napi.exports.run('bad',2);\n`;
      writeFileSync(
        join(consumer, "check.mts"),
        typing +
          `// @ts-expect-error unknown export\nimport {missing} from '${packageName}';\n`,
      );
      run(
        resolve("node_modules/.bin/tsc"),
        [
          "--strict",
          "--noEmit",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--lib",
          "ES2022,DOM",
          "check.mts",
        ],
        consumer,
      );
      const factory = async (add) => {
        const api = await import(
          `${pathToFileURL(join(deployed, "bundle.mjs")).href}?instance=${instance++}`
        );
        if (bindgen) {
          api.setBinding(add);
          api.initSync({ module: readFileSync(join(deployed, "app_bg.wasm")) });
          return api.run;
        }
        if (p.backend === "component")
          return (
            await api.instantiate(
              (name) =>
                new WebAssembly.Module(readFileSync(join(deployed, name))),
              { add: { default: add } },
            )
          ).run;
        const host = await api.instantiate(
          readFileSync(join(deployed, "app.wasm")),
          { bindings: { add } },
        );
        return host.exports.run;
      };
      const verified = async
        ? await verifyWit(factory, batches)
        : await verifySync(factory, batches);
      let scheduling = null;
      if (async && p.backend === "embassy") {
        // Embassy may start B before A: its ready queue need not promise FIFO.
        scheduling = await inspectScheduling(factory);
        assert.deepEqual(
          [...scheduling.started_before_release].sort((a, b) => a[0] - b[0]),
          [
            [10, 1],
            [20, 2],
          ],
        );
        assert.deepEqual(scheduling.completed_while_a_blocked, ["B"]);
        assert.deepEqual(scheduling.completion_order, ["B", "A"]);
      } else if (async && p.backend !== "component") {
        scheduling = await verifyScheduling(factory, {
          serialized: p.backend === "jspi",
        });
      }
      const capacity =
        async && p.backend === "embassy"
          ? await verifyEmbassyCapacity(factory)
          : null;
      const row = {
        ...p,
        id,
        workload,
        raw_rust_wasm_bytes: rawBytes.length,
        raw_rust_sha256: hash(rawBytes),
        ...measured,
        npm_tarball_bytes: readFileSync(tarball).length,
        packed_artifacts_verified: true,
        typescript_strict: true,
        files: { runtime, declarations, container },
        verified,
        scheduling,
        capacity,
      };
      report.entries.push(row);
      console.log(
        `${id}: Wasm ${row.wasm_bytes}, JS ${row.js_bytes}, runtime ${row.runtime.raw} B; ${verified.tasks} cases passed`,
      );
    }
  for (const p of profiles) {
    const rows = report.entries.filter(
      (e) =>
        e.backend === p.backend &&
        e.mode === p.mode &&
        e.allocator === p.allocator,
    );
    report.comparisons.push({
      ...p,
      sync: rows.find((e) => e.workload === "sync").id,
      async: rows.find((e) => e.workload === "async").id,
      growth: growth(
        rows.find((e) => e.workload === "sync"),
        rows.find((e) => e.workload === "async"),
      ),
    });
  }
  const inputs = [
    "Cargo.lock",
    "rust-toolchain.toml",
    "tests/consumer.test.mjs",
    "pnpm-lock.yaml",
    "tools/compare-async-size.mjs",
    "tools/install-wasm-bindgen.mjs",
    "tools/wasm-opt-contract.mjs",
    "tests/async-size.test.mjs",
    "tests/docs.test.mjs",
    "tests/support/wit-contract.mjs",
    "tests/support/async-contract.mjs",
    "tests/support/scheduling.mjs",
    "tests/support/metrics.mjs",
    "experiments/wit/shared/compute.rs",
    "crates/taraba-cli/assets/provenance.json",
    ...readdirSync("crates", { recursive: true })
      .filter((f) => /\.(rs|wit|wat|mjs|mts|json|toml)$/.test(f))
      .map((f) => `crates/${f}`),
    ...readdirSync("experiments/async-size", { recursive: true })
      .filter(
        (f) =>
          !/^(target|\.cache)\//.test(f) && /\.(rs|wit|mjs|toml|lock)$/.test(f),
      )
      .map((f) => `experiments/async-size/${f}`),
  ];
  report.inputs = Object.fromEntries(
    inputs.map((f) => [f, hash(readFileSync(f))]),
  );
  report.all_passed = true;
  writeFileSync(
    join(out, "check.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (!check) {
    writeFileSync(
      "docs/async-size.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    const { render, summary } =
      await import("../experiments/async-size/report.mjs");
    for (const lang of ["en", "ja"]) {
      writeFileSync(
        `docs/async-size${lang === "ja" ? ".ja" : ""}.md`,
        render(report, lang),
      );
      const path = lang === "ja" ? "README.ja.md" : "README.md";
      const current = readFileSync(path, "utf8");
      if (!current.includes("<!-- async-size:begin -->"))
        throw Error(`${path}: missing size table marker`);
      writeFileSync(
        path,
        current.replace(
          /<!-- async-size:begin -->[\s\S]*?<!-- async-size:end -->/,
          `<!-- async-size:begin -->\n${summary(report, lang)}\n<!-- async-size:end -->`,
        ),
      );
    }
  }
} catch (e) {
  writeFileSync(
    join(out, "failure.log"),
    `${e.stack || e}\n${e.stdout || ""}\n${e.stderr || ""}`,
  );
  throw Error(
    "Async size comparison failed; see .cache/async-size/failure.log",
  );
}
