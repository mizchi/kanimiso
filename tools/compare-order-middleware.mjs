import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, cpus, release } from "node:os";
import { pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { artifactSizes, summarize } from "../tests/support/metrics.mjs";
import { rustEnvironment } from "./rust-toolchain.mjs";
import {
  order,
  request,
  verifyMiddleware,
} from "../examples/order-middleware/contract.mjs";
import { packageHttp } from "../examples/order-middleware/package.mjs";
import { verifySizeBudget } from "../experiments/rich-async/metrics.mjs";
import { markdown } from "../examples/order-middleware/report.mjs";
const root = resolve("."),
  out = resolve(".cache/order-middleware"),
  example = resolve("examples/order-middleware"),
  cli = resolve("target/release/taraba");
mkdirSync(out, { recursive: true });
rmSync(join(out, "failure.log"), { force: true });
rmSync(join(out, "report.json"), { force: true });
const platform = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "macos" : process.platform}`;
const env = {
  ...rustEnvironment(root),
  TARABA_BINDGEN: cli,
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: join(out, "target"),
  RUSTFLAGS: "-C link-arg=-zstack-size=65536 -C link-arg=--max-memory=16777216",
};
const run = (bin, args, cwd = root) =>
  execFileSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
let instance = 0;
async function bundle(folder, backend) {
  const input =
    backend === "javascript"
      ? `import {processOrder} from ${JSON.stringify(join(example, "reference.mjs"))};export function createHost({bindings}){return {process:value=>processOrder(value,bindings.authorize)}}`
      : `export {${backend === "taraba" ? "createHost" : "instantiate"}} from ${JSON.stringify(join(folder, "index.js"))};${backend === "wit-bindgen" ? `export function wrapComponent(api){return {process:async value=>{try{return {tag:'ok',val:await api.process(value)}}catch(error){if(error&&Object.hasOwn(error,'payload')&&typeof error.payload==='string')return {tag:'err',val:error.payload};throw error;}}}}` : ""}`;
  const b = await rolldown({
    input: "virtual:middleware",
    plugins: [
      {
        name: "middleware",
        resolveId: (id) => (id === "virtual:middleware" ? id : null),
        load: (id) =>
          id === "virtual:middleware"
            ? `${input}\nexport {createMiddleware} from ${JSON.stringify(join(example, "http.mjs"))};`
            : null,
      },
    ],
    platform: "neutral",
    transform: { target: "es2022" },
  });
  try {
    const { output } = await b.generate({ format: "esm", minify: true });
    assert.equal(output.length, 1);
    writeFileSync(join(folder, "bundle.mjs"), output[0].code);
  } finally {
    await b.close();
  }
}
async function compile(backend, std = false, measured = false) {
  const folder = join(
    out,
    `${backend}-${std ? "std" : "no_std"}${measured ? "-measured" : ""}`,
  );
  mkdirSync(folder, { recursive: true });
  if (backend !== "javascript") {
    const features = [
      backend === "taraba" ? "core-runtime" : "component",
      ...(std ? ["std"] : []),
      ...(measured ? ["measured"] : []),
    ];
    run("cargo", [
      "build",
      "--locked",
      "--manifest-path",
      join(example, "Cargo.toml"),
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--no-default-features",
      "--features",
      features.join(","),
    ]);
    run(cli, [
      "build",
      join(
        env.CARGO_TARGET_DIR,
        "wasm32-unknown-unknown/release/taraba_order_middleware.wasm",
      ),
      "--wit",
      join(example, "wit"),
      "--world",
      measured ? "measured" : "app",
      "--out-dir",
      folder,
      "--npm-name",
      `@taraba-examples/orders-${backend}-${std ? "std" : "no-std"}`,
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
  }
  await bundle(folder, backend);
  return {
    folder,
    factory: async (authorize) => {
      const module = await import(
        `${pathToFileURL(join(folder, "bundle.mjs")).href}?instance=${instance++}`
      );
      if (backend === "javascript")
        return module.createHost({ bindings: { authorize } });
      if (backend === "taraba") {
        const host = module.createHost({ bindings: { authorize } });
        host.attach(
          (
            await WebAssembly.instantiate(
              readFileSync(join(folder, "app.wasm")),
              host.imports,
            )
          ).instance.exports,
        );
        return {
          process: host.process,
          dispose: host.dispose,
          live: host["heap-live"],
          peak: host["heap-peak"],
          reset: host["heap-reset"],
          linear: host["linear-bytes"],
        };
      }
      const api = await module.instantiate(
        (name) => WebAssembly.compile(readFileSync(join(folder, name))),
        { authorize: { default: authorize } },
      );
      return {
        ...module.wrapComponent(api),
        live: api.heapLive,
        peak: api.heapPeak,
        reset: api.heapReset,
        linear: api.linearBytes,
      };
    },
  };
}
const authorize = async () => {
  await Promise.resolve();
  return true;
};
function domainInput(count) {
  const body = order(count);
  return {
    tenant: "shop",
    customer: body.customer,
    items: body.items.map((v) => ({
      sku: v.sku,
      quantity: v.quantity,
      price: v.unitPrice,
    })),
    preview: false,
  };
}
async function performanceFor(app) {
  const api = await app.factory(authorize),
    { createMiddleware } = await import(
      pathToFileURL(join(app.folder, "bundle.mjs"))
    ),
    handle = createMiddleware(api),
    result = [];
  for (const count of [1, 32])
    for (const concurrency of [1, 16])
      for (const boundary of ["guest", "http"]) {
        const value = domainInput(count),
          body = order(count);
        const invoke =
          boundary === "guest"
            ? () => api.process(value)
            : async () => {
                const response = await handle(request(body));
                assert.equal(response.status, 200);
                await response.json();
              };
        const batch = () =>
          Promise.all(Array.from({ length: concurrency }, invoke));
        for (let i = 0; i < 10; i++) await batch();
        const samples = [];
        for (let i = 0; i < 7; i++) {
          const start = performance.now();
          for (let j = 0; j < 10; j++) await batch();
          samples.push(
            ((performance.now() - start) * 1000) / (10 * concurrency),
          );
        }
        result.push({
          boundary,
          items: count,
          concurrency,
          us_per_call: summarize(samples),
        });
      }
  api.dispose?.();
  return result;
}
async function startup(app) {
  const setup = [],
    first = [];
  for (let i = 0; i < 5; i++) {
    let start = performance.now();
    const api = await app.factory(authorize);
    setup.push(performance.now() - start);
    start = performance.now();
    assert.equal((await api.process(domainInput(1))).tag, "ok");
    first.push(performance.now() - start);
    api.dispose?.();
  }
  return {
    fresh_module_and_instance_ms: summarize(setup),
    first_domain_call_ms: summarize(first),
    engine_cache_flushed: false,
  };
}
async function quiesce() {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
}
async function memory(app) {
  const api = await app.factory(authorize),
    initial_linear_bytes = await api.linear(),
    samples = [];
  for (const concurrency of [1, 16, 32]) {
    await quiesce();
    const before = await api.live();
    await api.reset();
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => api.process(domainInput(32))),
    );
    for (const result of results) assert.equal(result.tag, "ok");
    await quiesce();
    samples.push({
      items: 32,
      concurrency,
      before_requested_heap_bytes: before,
      peak_requested_heap_bytes: await api.peak(),
      after_requested_heap_bytes: await api.live(),
      linear_bytes: await api.linear(),
    });
  }
  api.dispose?.();
  return { initial_linear_bytes, samples };
}
async function externalConsumer(app) {
  packageHttp(app.folder);
  const temp = mkdtempSync(join(tmpdir(), "taraba-orders-"));
  try {
    const packs = join(temp, "packs"),
      consumer = join(temp, "consumer");
    mkdirSync(packs);
    mkdirSync(consumer);
    run("pnpm", ["pack", "--pack-destination", packs], app.folder);
    const archive = join(
      packs,
      readdirSync(packs).find((f) => f.endsWith(".tgz")),
    );
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    run("pnpm", ["add", "--offline", archive], consumer);
    const name = JSON.parse(
      readFileSync(join(app.folder, "package.json")),
    ).name;
    writeFileSync(
      join(consumer, "consumer.mts"),
      `import {createHost,type AppBindings} from '${name}';import {createMiddleware} from '${name}/http';const bindings:AppBindings={authorize:async(tenant,total)=>tenant.length>0&&total>0};const host=createHost({bindings});const handler:(request:Request)=>Promise<Response>=createMiddleware(host);\n// @ts-expect-error invalid imported callback\ncreateHost({bindings:{authorize:async(tenant:number)=>true}});\n// @ts-expect-error wrong process contract\ncreateMiddleware({process:async(value:string)=>value});\n`,
    );
    for (const resolution of ["NodeNext", "bundler"])
      run(
        resolve("node_modules/.bin/tsc"),
        [
          "--strict",
          "--noEmit",
          "--target",
          "ES2022",
          "--module",
          resolution === "NodeNext" ? "NodeNext" : "ESNext",
          "--moduleResolution",
          resolution,
          "--lib",
          "ES2022,DOM",
          "consumer.mts",
        ],
        consumer,
      );
    writeFileSync(
      join(consumer, "entry.mjs"),
      `export {createHost} from '${name}';export {createMiddleware} from '${name}/http';`,
    );
    const module = await import(pathToFileURL(join(consumer, "entry.mjs"))),
      host = module.createHost({ bindings: { authorize } });
    host.attach(
      (
        await WebAssembly.instantiate(
          readFileSync(join(consumer, "node_modules", name, "app.wasm")),
          host.imports,
        )
      ).instance.exports,
    );
    const response = await module.createMiddleware(host)(request());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).total, 250);
    host.dispose();
    return {
      npm_pack_install: true,
      strict_typescript: ["NodeNext", "bundler"],
      http_export_executed: true,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
const entries = [];
try {
  for (const backend of ["javascript", "taraba", "wit-bindgen"])
    for (const std of backend === "javascript" ? [false] : [false, true]) {
      const app = await compile(backend, std),
        verified = await verifyMiddleware(app.factory);
      const files = [
        "bundle.mjs",
        ...readdirSync(app.folder).filter(
          (f) => f.endsWith(".wasm") && f !== "app.component.wasm",
        ),
      ];
      const artifacts = files.map((path) => {
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
      const row = {
        backend,
        mode: backend === "javascript" ? "host" : std ? "std" : "no_std",
        wasm_bytes,
        js_bytes,
        total_bytes: wasm_bytes + js_bytes,
        verified,
        artifacts,
        startup: await startup(app),
        performance: await performanceFor(app),
      };
      if (backend !== "javascript") {
        const measured = await compile(backend, std, true);
        await verifyMiddleware(measured.factory);
        row.memory = await memory(measured);
      }
      if (backend === "taraba") {
        row.consumer = await externalConsumer(app);
        const failure = { offline: true };
        let reject = true;
        const api = await app.factory(async () => {
          if (reject) throw failure;
          return true;
        });
        await assert.rejects(
          api.process(domainInput(1)),
          (error) => error === failure,
        );
        reject = false;
        assert.equal((await api.process(domainInput(1))).tag, "ok");
        api.dispose();
        row.foreign_rejection_identity_and_reuse = true;
      }
      entries.push(row);
      console.log(
        `${backend}/${row.mode}: ${wasm_bytes} B Wasm + ${js_bytes} B JS; ${verified.cases} shared HTTP/domain cases passed`,
      );
    }
  const inputs = [
    "examples/order-middleware/Cargo.toml",
    "examples/order-middleware/.cargo/config.toml",
    "examples/order-middleware/Cargo.lock",
    "examples/order-middleware/build.rs",
    "examples/order-middleware/wit/app.wit",
    "examples/order-middleware/src/lib.rs",
    "examples/order-middleware/src/workflow.rs",
    "examples/order-middleware/http.mjs",
    "examples/order-middleware/http.d.mts",
    "examples/order-middleware/package.mjs",
    "examples/order-middleware/reference.mjs",
    "examples/order-middleware/contract.mjs",
    "examples/order-middleware/report.mjs",
    "experiments/rich-async/src/measured.rs",
    "tools/compare-order-middleware.mjs",
    "crates/taraba-cli/assets/provenance.json",
    "Cargo.lock",
    "pnpm-lock.yaml",
    "rust-toolchain.toml",
    ...["taraba", "taraba-allocator", "taraba-cli"].flatMap((name) =>
      readdirSync(`crates/${name}/src`, { recursive: true })
        .filter((file) => file.endsWith(".rs"))
        .map((file) => `crates/${name}/src/${file}`),
    ),
  ];
  const report = {
    created_at: new Date().toISOString(),
    engine: `Node ${process.version} / V8 ${process.versions.v8}`,
    engine_flags: process.execArgv,
    machine: { cpu: cpus()[0]?.model, arch: process.arch, os: release() },
    rust: run("rustc", ["--version"]).trim(),
    git: {
      commit: run("git", ["rev-parse", "HEAD"]).trim(),
      dirty: Boolean(run("git", ["status", "--porcelain"]).trim()),
    },
    all_passed: true,
    methodology: {
      algorithm:
        "Identical Rust workflow for taraba Core Future and wit-bindgen Component. Independent JS baseline, shared URL/JSON/HTTP adapter and authorization callback, common literal expectations.",
      size: "All deployed core Wasm and one Rolldown-minified ESM including HTTP adapter; -Oz/LTO; same allocator without size classes. No measured exports in size/timing artifacts. Component container not counted twice.",
      performance:
        "10 warmup batches, 7 samples x 10 batches; latency includes Request/body parsing/Response JSON for HTTP, domain-only for guest. Parallel values are batch throughput per call.",
      startup:
        "Five fresh ESM module identities/instances on a warm process; engine caches NOT flushed. Includes JS import, Wasm compilation and instantiation; not engine-cold startup.",
      memory:
        "Separate counting allocator reused from rich-async; requested Rust heap only, excludes JS heap, allocator overhead/fragmentation and static task pool. Linear memory reported separately. Quiesce four timer/immediate turns.",
      limits:
        "Core private ABI and standard Component have different exception/cancellation contracts. This corpus covers common successful/domain-error requests. No network authorization latency, actual copy counts, Safari.app or production Workers measured.",
    },
    entries,
    inputs: Object.fromEntries(
      inputs.map((p) => [
        p,
        createHash("sha256").update(readFileSync(p)).digest("hex"),
      ]),
    ),
  };
  if (process.argv.includes("--check"))
    report.size_budget = verifySizeBudget(
      entries,
      JSON.parse(readFileSync("docs/order-middleware-size.json")).entries,
    );
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (process.argv.includes("--snapshot")) {
    writeFileSync(
      "docs/order-middleware-size.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    for (const ja of [false, true])
      writeFileSync(
        `docs/order-middleware${ja ? ".ja" : ""}.md`,
        markdown(report, ja),
      );
  }
} catch (error) {
  writeFileSync(
    join(out, "failure.log"),
    `${error.stack}\n${error.stdout || ""}\n${error.stderr || ""}`,
  );
  throw Error(
    "Order middleware check failed; see .cache/order-middleware/failure.log",
  );
}
