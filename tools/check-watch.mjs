import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rustEnvironment } from "./rust-toolchain.mjs";

// Isolate the test process group so cleanup interrupts Cargo children as a terminal would.
const signal = (child, kind) => {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(kind);
    else process.kill(-child.pid, kind);
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
};

// Exercise watch orchestration on the real WIT async fixtures, including Component+jco.
export async function verifyWatchOutput(
  cli,
  args,
  { cwd, env, expected, output },
) {
  const child = spawn(cli, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let log = "",
    settled = false;
  const exit = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal(child, "SIGINT");
      reject(Error(`watch output timeout\n${log}`));
    }, 60000);
    const data = (b) => {
      log += b;
      if (
        !settled &&
        (log.includes("watch build succeeded:") ||
          log.includes("watch build failed:"))
      ) {
        settled = true;
        signal(child, "SIGINT");
      }
    };
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    child.once("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (
        code !== 0 ||
        signal ||
        !log.includes("watch build succeeded:") ||
        log.includes("watch build failed:")
      )
        reject(Error(`watch output failed\n${log}`));
      else resolve();
    });
  });
  await exit;
  const pkg = JSON.parse(readFileSync(join(expected, "package.json")));
  for (const file of [...pkg.files, "package.json"].filter(
    (f) => f !== "build.json",
  )) {
    assert.deepEqual(
      readFileSync(join(output, file)),
      readFileSync(join(expected, file)),
      `watch output differs: ${file}`,
    );
  }
  return { initial_build_matches_one_shot: true, ctrl_c: true };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function verifyWatch(cli, env = process.env) {
  const temp = mkdtempSync(join(tmpdir(), "taraba-watch-check-"));
  const workspace = join(temp, "workspace"),
    app = join(workspace, "app"),
    shared = join(temp, "shared");
  const target = join(workspace, "custom-target"),
    out = join(workspace, "pkg");
  let active;
  const file = (path, content) => {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  const start = (args) => {
    let log = "",
      exited = false;
    const child = spawn(cli, args, {
      cwd: workspace,
      env: { ...env, CARGO_TARGET_DIR: target },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdout.on("data", (b) => {
      log += b;
    });
    child.stderr.on("data", (b) => {
      log += b;
    });
    const exit = new Promise((r) =>
      child.once("exit", (code, signal) => {
        exited = true;
        r({ code, signal });
      }),
    );
    child.on("error", (e) => {
      log += e.stack;
      exited = true;
    });
    const count = (text) => log.split(text).length - 1;
    const until = async (condition, label) => {
      const end = Date.now() + 45000;
      while (!condition()) {
        if (exited || Date.now() > end) throw Error(`${label}\n${log}`);
        await pause(25);
      }
    };
    return {
      child,
      exit,
      count,
      until,
      get log() {
        return log;
      },
      stop: async () => {
        if (!exited) signal(child, "SIGINT");
        const result = await Promise.race([exit, pause(5000).then(() => null)]);
        if (!result) {
          signal(child, "SIGKILL");
          await exit;
          throw Error(`watch failed to stop\n${log}`);
        }
        assert.deepEqual(result, { code: 0, signal: null }, log);
      },
    };
  };
  const result = (path) =>
    new WebAssembly.Instance(
      new WebAssembly.Module(readFileSync(path)),
    ).exports.run(20, 21);
  const source = `#![no_std]
#[panic_handler] fn panic(_: &core::panic::PanicInfo)->! {core::arch::wasm32::unreachable()}
#[unsafe(no_mangle)] pub extern "C" fn run(a:i32,b:i32)->i32 {a.wrapping_add(b).wrapping_add(shared::bias()).wrapping_add(if cfg!(feature="boost") {10} else {0})}`;
  const wit =
    "package test:watch; world app { export run: func(a:s32,b:s32)->s32; }";
  try {
    file(
      join(workspace, "Cargo.toml"),
      '[workspace]\nmembers=["app"]\nresolver="3"\n[profile.release]\npanic="abort"\n',
    );
    file(
      join(app, "Cargo.toml"),
      `[package]\nname="watch-app"\nversion="0.1.0"\nedition="2024"\n[lib]\nname="custom_artifact"\ncrate-type=["cdylib"]\n[features]\ndefault=[]\nboost=[]\n[dependencies]\nshared={path="../../shared"}\n`,
    );
    file(
      join(shared, "Cargo.toml"),
      '[package]\nname="shared"\nversion="0.1.0"\nedition="2024"\n',
    );
    file(join(shared, "src/lib.rs"), "#![no_std]\npub fn bias()->i32 {1}\n");
    file(join(app, "src/lib.rs"), "deliberate initial Rust error");
    file(join(app, "wit/app.wit"), wit);
    const once = (args, cwd = app) =>
      spawnSync(cli, ["build", ...args], {
        cwd,
        env: { ...env, CARGO_TARGET_DIR: target },
        encoding: "utf8",
      });
    let built = once([]);
    assert.notEqual(built.status, 0);
    assert.ok(built.stderr.includes("cargo build failed"), built.stderr);
    assert.ok(!existsSync(join(app, "pkg")));
    file(join(app, "src/lib.rs"), source);
    built = once([]);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(result(join(app, "pkg/app.wasm")), 42);
    const pkg = JSON.parse(readFileSync(join(app, "pkg/package.json")));
    assert.equal(
      pkg.name,
      "watch-app",
      "use Cargo package name, not custom lib name",
    );
    assert.equal(pkg.version, "0.1.0");
    assert.equal(pkg.license, "UNLICENSED");
    assert.equal(pkg.type, "module");
    assert.equal(pkg.main, "./index.js");
    assert.equal(pkg.types, "./index.d.ts");
    assert.ok(existsSync(join(app, "pkg/index.js")));
    assert.ok(existsSync(join(app, "pkg/index.d.ts")));
    assert.ok(!existsSync(join(app, "pkg/taraba.mjs")));

    const onceOut = join(workspace, "once-pkg");
    const onceArgs = [
      "--manifest-path",
      join(workspace, "Cargo.toml"),
      "--package",
      "watch-app",
      "--features",
      "boost",
      "--no-default-features",
      "--out-dir",
      onceOut,
    ];
    built = once(onceArgs, workspace);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(result(join(onceOut, "app.wasm")), 52);
    const inherited = JSON.parse(readFileSync(join(onceOut, "package.json")));
    assert.equal(inherited.name, "watch-app");
    const overridden = once(["--npm-version", "2.3.4", "--license", "MIT"]);
    assert.equal(overridden.status, 0, overridden.stderr);
    const changed = JSON.parse(readFileSync(join(app, "pkg/package.json")));
    assert.equal(changed.name, "watch-app");
    assert.equal(changed.version, "2.3.4");
    assert.equal(changed.license, "MIT");

    const previous = readFileSync(join(onceOut, "app.wasm"));
    file(join(app, "wit/app.wit"), "deliberate WIT error");
    built = once(onceArgs, workspace);
    assert.notEqual(built.status, 0);
    assert.deepEqual(readFileSync(join(onceOut, "app.wasm")), previous);
    file(join(app, "wit/app.wit"), wit);
    file(join(app, "src/lib.rs"), "deliberate initial Rust error");
    active = start([
      "build",
      "--watch",
      "--manifest-path",
      join(workspace, "Cargo.toml"),
      "--package",
      "watch-app",
      "--features",
      "boost",
      "--no-default-features",
      "--npm-name",
      "@taraba-tests/watch",
      "--out-dir",
      out,
    ]);
    await active.until(
      () => active.count("watch build failed:") >= 1,
      "initial Rust failure must remain watchable",
    );
    assert.ok(!existsSync(out));
    file(join(app, "src/lib.rs"), source);
    await active.until(
      () => active.count("watch build succeeded:") >= 1,
      "first recovered build",
    );
    const wasm = join(out, "app.wasm");
    assert.equal(result(wasm), 52);
    assert.equal(
      JSON.parse(readFileSync(join(out, "package.json"))).name,
      "@taraba-tests/watch",
    );
    const original = readFileSync(wasm);
    file(join(app, "wit/app.wit"), "deliberate WIT error");
    await active.until(
      () => active.count("watch build failed:") >= 2,
      "invalid WIT",
    );
    assert.deepEqual(
      readFileSync(wasm),
      original,
      "failed build must preserve last output",
    );
    file(join(app, "wit/app.wit"), wit + "\n");
    await active.until(
      () => active.count("watch build succeeded:") >= 2,
      "WIT recovery",
    );
    // Atomic saves of a local path dependency outside the workspace must trigger a build.
    file(join(shared, "src/next.rs"), "#![no_std]\npub fn bias()->i32 {3}\n");
    renameSync(join(shared, "src/next.rs"), join(shared, "src/lib.rs"));
    await active.until(
      () => active.count("watch build succeeded:") >= 3,
      "atomic dependency save",
    );
    assert.equal(result(wasm), 54);
    const completed = active.count("watch build succeeded:");
    for (const path of [
      join(target, "noise"),
      join(out, "noise"),
      join(workspace, "node_modules/test/noise"),
      join(workspace, ".git/noise"),
    ])
      file(path, "ignored");
    await pause(1200);
    assert.equal(
      active.count("watch build succeeded:"),
      completed,
      "generated output must not cause a rebuild loop\n" + active.log,
    );
    // Editing while Cargo is building must queue a subsequent, serial rebuild.
    const marker = join(temp, "building");
    file(
      join(app, "build.rs"),
      `fn main(){println!("cargo:rerun-if-changed=build.rs");std::fs::write(${JSON.stringify(marker)},"ready").unwrap();std::thread::sleep(std::time::Duration::from_millis(1000));}`,
    );
    await active.until(() => existsSync(marker), "build script entered");
    file(join(shared, "src/lib.rs"), "#![no_std]\npub fn bias()->i32 {7}\n");
    await active.until(
      () => active.count("watch build succeeded:") >= completed + 2,
      "edit during build must not be lost",
    );
    assert.equal(result(wasm), 58);
    const beforeManifest = active.count("watch build succeeded:"),
      beforeFailure = active.count("watch build failed:");
    const manifestFile = join(app, "Cargo.toml"),
      originalManifest = readFileSync(manifestFile);
    file(manifestFile, "invalid Cargo manifest {");
    await active.until(
      () => active.count("watch build failed:") > beforeFailure,
      "invalid Cargo manifest",
    );
    assert.equal(result(wasm), 58);
    file(manifestFile, originalManifest);
    await active.until(
      () => active.count("watch build succeeded:") > beforeManifest,
      "Cargo manifest recovery",
    );
    let before = active.count("watch build succeeded:");
    file(join(app, "src/nested/mod.rs"), "pub fn bonus()->i32 {2}\n");
    file(
      join(app, "src/lib.rs"),
      source.replace(
        "shared::bias()",
        "shared::bias().wrapping_add(nested::bonus())",
      ) + "\nmod nested;\n",
    );
    await active.until(
      () => active.count("watch build succeeded:") > before,
      "new source directory",
    );
    assert.equal(result(wasm), 60);
    before = active.count("watch build succeeded:");
    file(join(app, "src/nested/mod.rs"), "pub fn bonus()->i32 {4}\n");
    await active.until(
      () => active.count("watch build succeeded:") > before,
      "new directory remains watched",
    );
    assert.equal(result(wasm), 62);
    const beforeMetadata = active.count("watch build succeeded:");
    file(
      manifestFile,
      originalManifest
        .toString()
        .replace('version="0.1.0"', 'version="0.2.0"\nlicense="MIT"'),
    );
    await active.until(
      () => active.count("watch build succeeded:") > beforeMetadata,
      "package metadata change",
    );
    const refreshed = JSON.parse(readFileSync(join(out, "package.json")));
    assert.equal(refreshed.name, "@taraba-tests/watch");
    assert.equal(refreshed.version, "0.2.0");
    assert.equal(refreshed.license, "MIT");
    await active.stop();
    active = null;
    const raw = join(workspace, "input.wasm"),
      rawOut = join(workspace, "raw-pkg");
    file(raw, readFileSync(wasm));
    active = start([
      "build",
      raw,
      "--watch",
      "--wit",
      join(app, "wit"),
      "--future",
      "--debug",
      "--out-dir",
      rawOut,
    ]);
    await active.until(
      () => active.count("watch build succeeded:") >= 1,
      "raw Wasm initial build",
    );
    const rawPackage = JSON.parse(readFileSync(join(rawOut, "package.json")));
    assert.equal(rawPackage.name, "input");
    assert.equal(rawPackage.version, "0.1.0");
    assert.equal(rawPackage.license, "UNLICENSED");
    const info = JSON.parse(readFileSync(join(rawOut, "build.json")));
    assert.equal(info.profile, "wit-core-externref");
    assert.equal(info.debug, true);
    file(raw, new Uint8Array([0]));
    await active.until(
      () => active.count("watch build failed:") >= 1,
      "raw Wasm invalid input",
    );
    assert.equal(result(join(rawOut, "app.wasm")), 62);
    file(raw, readFileSync(wasm));
    await active.until(
      () => active.count("watch build succeeded:") >= 2,
      "raw Wasm recovery",
    );
    await active.stop();
    active = null;
    return {
      all_passed: true,
      project_build_defaults: true,
      project_build_features_and_artifact: true,
      project_build_failure_status: true,
      project_build_preserves_output: true,
      project_cargo: true,
      workspace_package: true,
      features: true,
      custom_target_and_artifact: true,
      initial_failure_recovery: true,
      wit_failure_preserves_output: true,
      external_path_dependency_atomic_save: true,
      ignored_outputs: true,
      queued_edit_during_build: true,
      cargo_manifest_recovery: true,
      new_directories: true,
      raw_future_debug_recovery: true,
      ctrl_c: true,
    };
  } finally {
    if (active) {
      signal(active.child, "SIGINT");
      await active.exit;
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const env = rustEnvironment(resolve("."));
  env.TARABA_BINARYEN = resolve(".cache/toolchains/binaryen-version_133/bin");
  mkdirSync(".cache", { recursive: true });
  let report;
  try {
    report = await verifyWatch(resolve("target/release/taraba"), env);
  } catch (e) {
    writeFileSync(".cache/watch-check.log", String(e.stack || e));
    throw e;
  }
  report.inputs = Object.fromEntries(
    [
      "Cargo.lock",
      "crates/taraba-cli/Cargo.toml",
      "crates/taraba-cli/src/main.rs",
      "crates/taraba-cli/src/project_build.rs",
      "crates/taraba-cli/src/detect.rs",
      "crates/taraba-cli/src/watch.rs",
      "tools/check-watch.mjs",
      "tools/rust-toolchain.mjs",
    ].map((p) => [
      p,
      createHash("sha256").update(readFileSync(p)).digest("hex"),
    ]),
  );
  writeFileSync(
    ".cache/watch-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    "watch: Cargo/workspace/features, atomic saves, queued edits, failure recovery, output isolation and Ctrl-C passed",
  );
}
