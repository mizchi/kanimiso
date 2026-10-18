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
async function install(out, profile, id, rich = false) {
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
    contents.includes(
      profile === "component" ? "package/app.d.ts" : "package/index.d.mts",
    ),
  );
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
  assert.equal(pkg.license, "MIT");
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run("pnpm", ["add", "--offline", tarball], consumer);
  writeFileSync(
    join(consumer, "entry.mjs"),
    `export {instantiate} from ${JSON.stringify(pkg.name)};`,
  );
  const { instantiate } = await import(
    pathToFileURL(join(consumer, "entry.mjs"))
  );
  const installed = join(consumer, "node_modules", pkg.name);
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
import {instantiate} from '${pkg.name}';
const api = await instantiate(new Uint8Array(), {bindings: {add: async (a,b) => a+b}});
const result: ${profile === "jspi" ? "number" : "unknown"} = await api.exports.run(1,2);
// @ts-expect-error invalid argument
await api.exports.run('bad',2);
// @ts-expect-error unknown export
await api.exports.missing(1,2);
${profile === "future" ? "// @ts-expect-error opaque Promise resource payload must stay unknown\nconst scalar: number = await api.exports.run(1,2);" : ""}
`;
  writeFileSync(join(consumer, "consumer.mts"), ts);
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
    ],
    consumer,
  );
  return {
    instantiate,
    load,
    installed,
    bytes: readFileSync(tarball).length,
    files: contents.trim().split("\n"),
  };
}
try {
  for (const profile of ["jspi", "future", "component"]) {
    const project = scaffold(profile);
    for (const std of [false, true]) {
      const raw = compile(project, std),
        id = `${profile}-${std ? "std" : "no-std"}`,
        out = join(temp, `pkg-${id}`);
      mkdirSync(out);
      writeFileSync(join(out, "stale.wasm"), "not a build output");
      build(raw, project, profile, out, `@taraba-tests/${id}`);
      const installed = await install(out, profile, id);
      const factory = async (add) => {
        if (profile === "component")
          return (
            await installed.instantiate(installed.load, {
              add: { default: add },
            })
          ).run;
        const host = await installed.instantiate(
          readFileSync(join(installed.installed, "app.wasm")),
          { bindings: { add } },
        );
        return host.exports.run;
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
      }
      report.cases.push({
        id,
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
      "example:orders/domain": {
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
  report.all_passed = true;
  report.inputs = Object.fromEntries(
    [
      "tools/check-library.mjs",
      "Cargo.lock",
      "pnpm-lock.yaml",
      ...readdirSync("crates/taraba-cli/src", { recursive: true })
        .filter((f) => f.endsWith(".rs") || f.endsWith(".wit"))
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
