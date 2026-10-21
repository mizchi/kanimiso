import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rustEnvironment } from "./rust-toolchain.mjs";
import { verifyWit } from "../tests/support/wit-contract.mjs";
import { verifyScheduling } from "../tests/support/scheduling.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";
import { verifyEsmCache } from "./check-esm-cache.mjs";
import { verifyTaskFeatures } from "./check-task-features.mjs";
import { verifyCoreAsync } from "./check-core-async.mjs";
import { verifyWatchOutput } from "./check-watch.mjs";

const root = resolve(".");
const temp = mkdtempSync(join(tmpdir(), "taraba-library-"));
const cli = process.env.TARABA_LIBRARY_CLI || resolve("target/release/taraba");
const runtime = process.env.TARABA_LIBRARY_RUNTIME || resolve("crates/taraba");
const allocator =
  process.env.TARABA_LIBRARY_ALLOCATOR || resolve("crates/taraba-allocator");
const wasmToolsPlatform = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "macos" : process.platform}`;
const wasmTools = resolve(
  `.cache/toolchains/wasm-tools-1.245.1-${wasmToolsPlatform}/wasm-tools`,
);
const env = {
  ...rustEnvironment(root),
  TARABA_BINDGEN: cli,
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: resolve(".cache/library-consumer-target"),
};
const run = (bin, args, cwd = root) =>
  execFileSync(bin, args, {
    cwd,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
const report = {
  published: false,
  safari_browser_verified: false,
  cases: [],
  default_npm: [],
  rich_types: [],
};
const batches = [1, 16, 128, 1024].flatMap((c) => asyncCases(c));
function scaffold(profile, name = profile) {
  const project = join(temp, `library-${name}`);
  run(cli, [
    "new",
    project,
    "--no-std",
    ...(profile === "jspi" ? [] : [`--${profile}`]),
  ]);
  const manifest = join(project, "Cargo.toml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8") +
      `\n[patch.crates-io]\ntaraba-allocator = {path = ${JSON.stringify(allocator)}}\n` +
      (profile === "future"
        ? `taraba = {path = ${JSON.stringify(runtime)}}\n`
        : ""),
  );
  run("cargo", ["fetch"], project);
  return project;
}
function compile(project, std) {
  run(
    "cargo",
    [
      "build",
      "--locked",
      "--offline",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      ...(std ? ["--features", "std"] : []),
    ],
    project,
  );
  return join(
    env.CARGO_TARGET_DIR,
    "wasm32-unknown-unknown/release",
    `${project.split("/").at(-1).replaceAll("-", "_")}.wasm`,
  );
}
function build(raw, project, profile, out, name) {
  run(cli, [
    "build",
    raw,
    "--wit",
    join(project, "wit"),
    "--out-dir",
    out,
    ...(profile === "jspi" ? [] : [`--${profile}`]),
    ...(profile === "component"
      ? ["--wasm-tools", wasmTools, "--jco", resolve("node_modules/.bin/jco")]
      : []),
    "--npm-name",
    name,
    "--npm-version",
    "0.1.0-test.1",
    "--license",
    "MIT",
  ]);
}
function verifyUpdate(output) {
  const recipeFile = join(output, ".taraba/rebuild.json");
  const recipe = JSON.parse(readFileSync(recipeFile));
  assert.ok(!recipe.args.includes("--watch"));
  const pkg = JSON.parse(readFileSync(join(output, "package.json")));
  assert.ok(!pkg.files.some((f) => f.startsWith(".taraba/")));
  const expected = new Map(
    [...pkg.files, "package.json"].map((f) => [
      f,
      readFileSync(join(output, f)),
    ]),
  );
  run(cli, ["update", "--out-dir", output, "--check"]);
  // A changed asset with the same CLI version must also be detected.
  recipe.assets.assets["taraba.mjs"] = "older runtime";
  writeFileSync(recipeFile, JSON.stringify(recipe));
  assert.throws(
    () => run(cli, ["update", "--out-dir", output, "--check"]),
    (e) => String(e.stderr).includes("update available"),
  );
  for (const [file, bytes] of expected)
    assert.deepEqual(readFileSync(join(output, file)), bytes);
  writeFileSync(join(output, "index.js"), "stale generated entry");
  run(cli, ["update", "--out-dir", output]);
  run(cli, ["update", "--out-dir", output, "--check"]);
  for (const [file, bytes] of expected)
    assert.deepEqual(
      readFileSync(join(output, file)),
      bytes,
      `update changed build options: ${file}`,
    );
  const updated = JSON.parse(readFileSync(recipeFile));
  assert.deepEqual(updated.args, recipe.args);
  assert.deepEqual(updated.cwd, recipe.cwd);
  return {
    assets_regenerated: true,
    build_options_preserved: true,
    local_recipe_excluded_from_npm: true,
  };
}
async function install(out, profile, id, rich = false, license = "MIT") {
  const consumer = join(temp, `consumer-${id}`),
    packs = join(temp, `packs-${id}`);
  mkdirSync(consumer);
  mkdirSync(packs);
  run("pnpm", ["pack", "--pack-destination", packs], out);
  const tarball = join(
    packs,
    readdirSync(packs).find((f) => f.endsWith(".tgz")),
  );
  const contents = run("tar", ["-tzf", tarball]).toString();
  assert.ok(
    !contents.includes(".taraba/"),
    "local source paths/build recipes must not enter npm packages",
  );
  assert.ok(contents.includes("package/index.d.ts"));
  const notices = [
    "LICENSE.taraba",
    "LICENSE.taraba-allocator",
    "NOTICE.taraba",
    "UPSTREAM.taraba-allocator.json",
  ];
  for (const file of notices) assert.ok(contents.includes(`package/${file}`));
  assert.ok(
    contents.includes(
      profile === "component"
        ? "package/app.component.wasm"
        : "package/app.wasm",
    ),
  );
  assert.ok(
    !contents.includes("stale.wasm"),
    "old output files must not leak into npm packages",
  );
  const pkg = JSON.parse(readFileSync(join(out, "package.json")));
  assert.equal(Object.keys(pkg.exports["."])[0], "types");
  assert.equal(pkg.license, license);
  assert.equal(pkg.main, "./index.js");
  assert.equal(pkg.module, "./index.js");
  assert.equal(pkg.types, "./index.d.ts");
  if (profile !== "component") {
    assert.ok(!contents.includes("package/taraba.mjs"));
    assert.ok(
      !contents.includes("package/error-codes.json"),
      "runtime descriptions belong in docs, not in the npm payload",
    );
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run("pnpm", ["add", "--offline", tarball], consumer);
  writeFileSync(
    join(consumer, "entry.mjs"),
    `export {${profile === "component" ? "instantiate" : "createHost"}} from ${JSON.stringify(pkg.name)};`,
  );
  const { instantiate, createHost } = await import(
    pathToFileURL(join(consumer, "entry.mjs"))
  );
  const installed = join(consumer, "node_modules", pkg.name);
  for (const file of notices)
    assert.ok(readFileSync(join(installed, file)).length > 0);
  const notice = readFileSync(join(installed, "NOTICE.taraba"), "utf8");
  assert.ok(
    notice.includes(
      `https://crates.io/api/v1/crates/taraba-allocator/${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}/download`,
    ),
  );
  assert.ok(
    notice.includes(
      "https://crates.io/api/v1/crates/memory_units/0.4.0/download",
    ),
  );
  const load = async (file) =>
    WebAssembly.compile(readFileSync(join(installed, file)));
  const ts =
    profile === "component"
      ? rich
        ? `
import {instantiate, type ImportObject, type Root} from '${pkg.name}';
const imports: ImportObject = {'example:orders/domain@0.1.0': {evaluate: async order => order}};
const load = async (_: string): Promise<WebAssembly.Module> => new WebAssembly.Module(new Uint8Array());
const api: Root = await instantiate(load, imports);
const order = await api.process({id: 1, label: 'a', amounts: new Uint32Array([1,2])});
const label: string = order.label;
// @ts-expect-error record field types must come from WIT
await api.process({id: 'bad', label: '', amounts: new Uint32Array()});
// @ts-expect-error rich result is not a scalar
const invalid: number = order;
`
        : `
import {instantiate, type Root} from '${pkg.name}';
const load = async (_: string): Promise<WebAssembly.Module> => new WebAssembly.Module(new Uint8Array());
const api: Root = await instantiate(load, {add: {default: async (a,b) => a+b}});
const result: number = await api.run(1,2);
// @ts-expect-error async return is a Promise
const sync: number = api.run(1,2);
// @ts-expect-error invalid argument
await api.run('bad',2);
// @ts-expect-error missing import must be rejected
await instantiate(load, {});
`
      : `
import {createHost} from '${pkg.name}';
const api = createHost({bindings: {add: async (a,b) => a+b}});
api.attach((await WebAssembly.instantiate(new Uint8Array(), api.imports)).instance.exports);
// @ts-expect-error the Core entry has no convenience loader
import {instantiate as removedLoader} from '${pkg.name}';
const explicit = createHost({bindings: {add: async (a,b) => a+b}});
const loaded = await WebAssembly.instantiate(new Uint8Array(), explicit.imports);
explicit.attach(loaded.instance.exports);
const explicitResult: number = await explicit.run(1,2);
// @ts-expect-error bindings must match WIT
createHost({bindings: {add: async (_: string) => 1}});
const result: number = await api.run(1,2);
// @ts-expect-error invalid argument
await api.run('bad',2);
// @ts-expect-error generic dispatch is private
api.call('run', 1, 2);
// @ts-expect-error ownership helpers are private Wasm imports
api.root({});
// @ts-expect-error unknown export
await api.missing(1,2);
// @ts-expect-error typed Future payload must be numeric
const badResult: string = await api.run(1,2);
`;
  const plainTypes =
    profile === "component"
      ? ""
      : `
import {createHost as plainHost, type AppBindings} from './node_modules/${pkg.name}/index.js';
const bindings: AppBindings = {add: async (a,b) => { const n: number = a; return n+b; }};
const plain = plainHost({bindings});
plain.attach((await WebAssembly.instantiate(new Uint8Array(), plain.imports)).instance.exports);
const plainResult: number = await plain.run(1,2);
// @ts-expect-error callback argument comes from WIT
plainHost({bindings: {add: (_: string) => 1}});
// @ts-expect-error missing WIT import
plainHost({bindings: {}});
// @ts-expect-error required bindings cannot be omitted
plainHost();
// @ts-expect-error unknown binding
plainHost({bindings: {add: async (a,b) => a+b, missing: () => 1}});
// @ts-expect-error invalid export argument
plain.run('bad',2);
// @ts-expect-error unknown export
plain.missing(1,2);
// @ts-expect-error direct methods always return Promises
const synchronous: number = plain.run(1,2);
// @ts-expect-error scalar callback result must match WIT
plainHost({bindings: {add: async (a,b) => 'bad'}});
`;
  writeFileSync(join(consumer, "consumer.mts"), ts + plainTypes);
  if (profile !== "component") {
    writeFileSync(
      join(consumer, "editor.mjs"),
      `// @ts-check
import {createHost} from './node_modules/${pkg.name}/index.js';
const host = createHost({bindings: {add: async (a,b) => {
  a.toFixed(); b.toFixed();
  // @ts-expect-error callback arguments are numbers, even in JS
  a.toUpperCase();
  return a+b;
}}});
host.run(1,2);
// @ts-expect-error WIT export arguments are checked in JS
host.run('bad',2);
// @ts-expect-error method completion must not expose unknown exports
host.missing();
`,
    );
  }
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
      "consumer.mts",
      ...(profile === "component"
        ? []
        : ["--allowJs", "--checkJs", "editor.mjs"]),
    ],
    consumer,
  );
  if (profile !== "component") {
    const wasm = readFileSync(join(installed, "app.wasm"));
    for (const source of [wasm, new WebAssembly.Module(wasm)]) {
      const host = createHost({
        bindings: { add: async (a, b) => (a + b) | 0 },
      });
      const loaded = await WebAssembly.instantiate(source, host.imports);
      host.attach(
        (loaded instanceof WebAssembly.Instance ? loaded : loaded.instance)
          .exports,
      );
      assert.equal(await host.run(20, 21), 42);
      for (const removed of [
        "call",
        "promise",
        "root",
        "get",
        "take",
        "release",
      ])
        assert.equal(removed in host, false, removed);
    }
  }
  return {
    instantiate,
    createHost,
    load,
    installed,
    tarball,
    name: pkg.name,
    bytes: readFileSync(tarball).length,
    files: contents.trim().split("\n"),
  };
}
try {
  const corePackages = [];
  for (const profile of ["jspi", "future", "component"]) {
    const project = scaffold(profile);
    for (const std of [false, true]) {
      if (!std && profile !== "component") {
        const defaults = join(temp, `default-${profile}`);
        run(cli, ["build", "--out-dir", defaults], project);
        const pkg = JSON.parse(readFileSync(join(defaults, "package.json")));
        assert.equal(pkg.name, `library-${profile}`);
        assert.equal(pkg.version, "0.1.0");
        assert.equal(pkg.license, "UNLICENSED");
        const ready = await install(
          defaults,
          profile,
          `default-${profile}`,
          false,
          "UNLICENSED",
        );
        const h = ready.createHost({
          bindings: { add: async (a, b) => (a + b) | 0 },
        });
        const { instance } = await WebAssembly.instantiate(
          readFileSync(join(ready.installed, "app.wasm")),
          h.imports,
        );
        h.attach(instance.exports);
        assert.equal(await h.run(20, 21), 42);
        report.default_npm.push({
          id: `default-${profile}`,
          npm_without_flags: true,
          packed: true,
          strict_typescript: true,
        });
      }
      const raw = compile(project, std),
        id = `${profile}-${std ? "std" : "no-std"}`,
        out = join(temp, `pkg-${id}`);
      mkdirSync(out);
      writeFileSync(join(out, "stale.wasm"), "not a build output");
      build(raw, project, profile, out, `@taraba-tests/${id}`);
      const projectOut = join(temp, `project-${id}`);
      run(
        cli,
        [
          "build",
          ...(profile === "component" ? ["--component"] : []),
          ...(std ? ["--features", "std"] : []),
          "--out-dir",
          projectOut,
          ...(profile === "component"
            ? [
                "--wasm-tools",
                wasmTools,
                "--jco",
                resolve("node_modules/.bin/jco"),
              ]
            : []),
          "--npm-name",
          `@taraba-tests/${id}`,
          "--npm-version",
          "0.1.0-test.1",
          "--license",
          "MIT",
        ],
        project,
      );
      const expectedPackage = JSON.parse(
        readFileSync(join(out, "package.json")),
      );
      for (const file of [...expectedPackage.files, "package.json"].filter(
        (f) => f !== "build.json",
      ))
        assert.deepEqual(
          readFileSync(join(projectOut, file)),
          readFileSync(join(out, file)),
          `${id}: project build differs: ${file}`,
        );
      const watch = !std
        ? await verifyWatchOutput(
            cli,
            [
              "build",
              ...(profile === "component" ? ["--component"] : []),
              "--watch",
              "--manifest-path",
              join(project, "Cargo.toml"),
              "--out-dir",
              join(temp, `watch-${id}`),
              ...(profile === "component"
                ? [
                    "--wasm-tools",
                    wasmTools,
                    "--jco",
                    resolve("node_modules/.bin/jco"),
                  ]
                : []),
              "--npm-name",
              `@taraba-tests/${id}`,
              "--npm-version",
              "0.1.0-test.1",
              "--license",
              "MIT",
            ],
            {
              cwd: project,
              env,
              expected: out,
              output: join(temp, `watch-${id}`),
            },
          )
        : null;
      const update = {
        raw: verifyUpdate(out),
        cargo: verifyUpdate(projectOut),
        watch: watch ? verifyUpdate(join(temp, `watch-${id}`)) : null,
      };
      if (id === "jspi-no-std") {
        // A second update must reuse the source paths, not a deleted staging directory.
        verifyUpdate(projectOut);
        const source = join(project, "src/lib.rs");
        const bytes = readFileSync(source);
        const previous = readFileSync(join(projectOut, "app.wasm"));
        const receipt = readFileSync(join(projectOut, ".taraba/rebuild.json"));
        try {
          writeFileSync(source, "intentional Rust syntax error");
          assert.throws(
            () => run(cli, ["update", "--out-dir", projectOut]),
            (e) => String(e.stderr).includes("previous output was preserved"),
          );
          assert.deepEqual(
            readFileSync(join(projectOut, "app.wasm")),
            previous,
          );
          assert.deepEqual(
            readFileSync(join(projectOut, ".taraba/rebuild.json")),
            receipt,
          );
        } finally {
          writeFileSync(source, bytes);
        }
        update.failed_build_preserves_output = true;
      }
      const installed = await install(projectOut, profile, id);
      if (profile !== "component") corePackages.push({ ...installed, profile });
      const factory = async (add) => {
        if (profile === "component")
          return (
            await installed.instantiate(installed.load, {
              add: { default: add },
            })
          ).run;
        const host = installed.createHost({ bindings: { add } });
        const { instance } = await WebAssembly.instantiate(
          readFileSync(join(installed.installed, "app.wasm")),
          host.imports,
        );
        host.attach(instance.exports);
        return host.run;
      };
      const verified = await verifyWit(factory, batches);
      const scheduling =
        profile === "component"
          ? null
          : await verifyScheduling(factory, { serialized: profile === "jspi" });
      const metadata = JSON.parse(readFileSync(join(out, "build.json")));
      assert.equal(
        metadata.profile,
        profile === "component"
          ? "component"
          : profile === "jspi"
            ? "wit-core-jspi"
            : "wit-core-externref",
      );
      if (profile === "component") {
        // Same wasm32 scalar ABI, incompatible WIT types: the Component contract must catch this.
        const mismatch = join(temp, `wrong-${id}.wit`);
        writeFileSync(
          mismatch,
          "package taraba:app@0.1.0; world app { import add: async func(a:s32,b:s32)->s32; export run: async func(a:s32,b:s32)->u32; }",
        );
        assert.throws(() =>
          run(cli, [
            "build",
            raw,
            "--wit",
            mismatch,
            "--component",
            "--wasm-tools",
            wasmTools,
            "--out-dir",
            join(temp, `wrong-${id}`),
          ]),
        );
        const componentOut = join(temp, `only-${id}`);
        run(cli, [
          "build",
          raw,
          "--wit",
          join(project, "wit"),
          "--component",
          "--wasm-tools",
          wasmTools,
          "--out-dir",
          componentOut,
        ]);
        assert.deepEqual(
          readFileSync(join(componentOut, "app.component.wasm")),
          readFileSync(join(out, "app.component.wasm")),
        );
        assert.ok(!readdirSync(componentOut).includes("package.json"));
        run(cli, ["update", "--out-dir", componentOut]);
        run(cli, ["update", "--out-dir", componentOut, "--check"]);
        assert.deepEqual(
          readFileSync(join(componentOut, "app.component.wasm")),
          readFileSync(join(out, "app.component.wasm")),
        );
      }
      report.cases.push({
        id,
        watch,
        update,
        ...verified,
        scheduling,
        typescript_strict: true,
        npm_tarball_bytes: installed.bytes,
        files: installed.files,
      });
      console.log(
        `library ${id}: packed, installed, strict TypeScript, ${verified.tasks} shared cases passed`,
      );
    }
  }
  // Install four independent npm artifacts into one app, then share only matching JS runtimes.
  const sharedConsumer = join(temp, "consumer-shared");
  mkdirSync(sharedConsumer);
  writeFileSync(
    join(sharedConsumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(
    "pnpm",
    ["add", "--offline", ...corePackages.map((p) => p.tarball)],
    sharedConsumer,
  );
  report.esm_cache = await verifyEsmCache(
    corePackages.map((p) => ({
      profile: p.profile,
      name: p.name,
      installed: join(sharedConsumer, "node_modules", p.name),
    })),
    join(sharedConsumer, "bundles"),
  );
  console.log(
    "library ESM cache: JSPI/Future each share one runtime chunk; per-instance state isolated",
  );
  // Rich WIT domain values and typed async application errors use Canonical ABI.
  const project = scaffold("component", "rich");
  // Recreate with Component dependencies rather than the default JSPI scaffold.
  const componentManifest = readFileSync(
    join(temp, "library-component/Cargo.toml"),
    "utf8",
  ).replace('name = "library-component"', 'name = "library-rich"');
  writeFileSync(join(project, "Cargo.toml"), componentManifest);
  writeFileSync(
    join(project, "wit/app.wit"),
    `package example:orders@0.1.0;
interface domain {
 record order { id: u32, label: string, amounts: list<u32> }
 evaluate: async func(order: order) -> result<order, string>;
}
world app {
 import domain;
 use domain.{order};
 export process: async func(order: order) -> result<order, string>;
}`,
  );
  writeFileSync(
    join(project, "src/lib.rs"),
    `#![cfg_attr(not(feature="std"),no_std)]
extern crate alloc;
#[global_allocator] static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(not(feature="std"))] #[panic_handler] fn panic(_: &core::panic::PanicInfo)->! {core::arch::wasm32::unreachable()}
wit_bindgen::generate!({path:"wit",world:"app"});
struct App;
impl Guest for App {async fn process(order: Order)->Result<Order,alloc::string::String> {example::orders::domain::evaluate(order).await}}
export!(App);`,
  );
  run("cargo", ["fetch"], project);
  for (const std of [false, true]) {
    const raw = compile(project, std),
      id = `rich-${std ? "std" : "no-std"}`,
      out = join(temp, `pkg-${id}`);
    build(raw, project, "component", out, `@taraba-tests/${id}`);
    const installed = await install(out, "component", id, true);
    const seen = [];
    const api = await installed.instantiate(installed.load, {
      "example:orders/domain@0.1.0": {
        evaluate: async (order) => {
          seen.push(structuredClone(order));
          if (order.label === "denied") throw "denied";
          return {
            ...order,
            label: order.label + " ✓",
            amounts: order.amounts.map((n) => n + 1),
          };
        },
      },
    });
    const order = {
      id: 4294967295,
      label: "注文 🍣",
      amounts: new Uint32Array([0, 1, 2147483648]),
    };
    assert.deepEqual(await api.process(order), {
      ...order,
      label: order.label + " ✓",
      amounts: new Uint32Array([1, 2, 2147483649]),
    });
    assert.deepEqual(seen, [order]);
    await assert.rejects(
      api.process({ ...order, label: "denied" }),
      (e) => e.payload === "denied",
    );
    assert.equal(
      (await api.process(order)).label,
      order.label + " ✓",
      "typed WIT application error must not poison the instance",
    );
    report.rich_types.push({
      id,
      records: true,
      strings: true,
      lists: true,
      u32_max: true,
      typed_error_and_recovery: true,
      typescript_strict: true,
    });
    console.log(
      `library ${id}: record/string/list/result and strict TypeScript passed`,
    );
  }
  report.core_async = await verifyCoreAsync({ cli, env, runtime, allocator });
  console.log(
    execFileSync(process.execPath, ["tools/check-core-types.mjs"], {
      cwd: root,
      env: { ...env, TARABA_LIBRARY_CLI: cli },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  report.core_types = JSON.parse(
    readFileSync(".cache/core-types-check.json", "utf8"),
  );
  report.task_features = await verifyTaskFeatures({
    cli,
    env,
    runtime,
    allocator,
  });
  for (const script of [
    "check-runtime-abi.mjs",
    "check-interfaces.mjs",
    "check-resources.mjs",
    "check-guest-resources.mjs",
    "check-pool.mjs",
  ]) {
    console.log(
      execFileSync(process.execPath, [`tools/${script}`], {
        cwd: root,
        env: {
          ...env,
          TARABA_LIBRARY_CLI: cli,
          TARABA_LIBRARY_RUNTIME: runtime,
          TARABA_LIBRARY_ALLOCATOR: allocator,
        },
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
  }
  report.all_passed = true;
  report.inputs = Object.fromEntries(
    [
      "tools/check-library.mjs",
      "tools/check-core-async.mjs",
      "tools/check-task-features.mjs",
      "tools/check-core-types.mjs",
      "tools/check-resources.mjs",
      "tools/check-guest-resources.mjs",
      "tests/support/guest-resources.mjs",
      "docs/resources.md",
      "docs/resources.ja.md",
      "crates/taraba/src/resource.rs",
      "tools/check-esm-cache.mjs",
      "tools/shared-runtime.mjs",
      "tools/check-watch.mjs",
      "Cargo.lock",
      "pnpm-lock.yaml",
      ...readdirSync("crates/taraba-cli/src", { recursive: true })
        .filter(
          (f) => f.endsWith(".rs") || f.endsWith(".wit") || f.endsWith(".mjs"),
        )
        .map((f) => `crates/taraba-cli/src/${f}`),
    ].map((f) => [
      f,
      createHash("sha256").update(readFileSync(f)).digest("hex"),
    ]),
  );
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    ".cache/library-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
} catch (e) {
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    ".cache/library-check-error.log",
    `${e.stack || e}\n${e.stdout || ""}\n${e.stderr || ""}`,
  );
  throw Error("Library check failed; see .cache/library-check-error.log");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
