import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rustEnvironment } from "./rust-toolchain.mjs";
const root = resolve("."),
  cli = process.env.TARABA_LIBRARY_CLI || resolve("target/release/taraba"),
  temp = mkdtempSync(join(tmpdir(), "taraba-pool-"));
const env = {
  ...rustEnvironment(root),
  TARABA_BINDGEN: cli,
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: resolve(".cache/pool-target"),
};
const run = (bin, args, cwd = temp) =>
  execFileSync(bin, args, {
    cwd,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
try {
  const project = join(temp, "pool");
  run(cli, ["new", project, "--future", "--no-std"]);
  const manifest = join(project, "Cargo.toml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8") +
      `\n[patch.crates-io]\ntaraba={path=${JSON.stringify(process.env.TARABA_LIBRARY_RUNTIME || resolve("crates/taraba"))}}\ntaraba-allocator={path=${JSON.stringify(process.env.TARABA_LIBRARY_ALLOCATOR || resolve("crates/taraba-allocator"))}}\n`,
  );
  writeFileSync(
    join(project, "wit/app.wit"),
    "package test:pool;world app {import wait:async func();export run:async func();}",
  );
  const lib = join(project, "src/lib.rs"),
    prefix = readFileSync(lib, "utf8").split("include!(")[0];
  writeFileSync(
    lib,
    prefix +
      `include!(concat!(env!("OUT_DIR"),"/bindings.rs"));bindings!();struct App;impl Guest for App {async fn run()->HostResult<()>{wait().await}}export!(App);`,
  );
  const report = [];
  for (const slots of [1, 16, 1024]) {
    const output = join(project, `pkg-${slots}`);
    run(
      cli,
      ["build", "--task-slots", String(slots), "--out-dir", output],
      project,
    );
    const info = JSON.parse(readFileSync(join(output, "build.json")));
    assert.equal(info.task_slots, slots);
    assert.equal(info.task_pool_bytes, slots * 128);
    const wasm = readFileSync(join(output, "app.wasm")),
      module = await WebAssembly.compile(wasm);
    assert.equal(
      WebAssembly.Module.customSections(module, "taraba:task-slots").length,
      0,
    );
    const { createHost } = await import(
      pathToFileURL(join(output, "index.js"))
    );
    const host = createHost({
      bindings: { wait: () => new Promise(() => {}) },
    });
    const instance = await WebAssembly.instantiate(module, host.imports);
    host.attach(instance.exports);
    const pending = Array.from({ length: slots }, () => host.run());
    for (const p of pending) p.catch(() => {});
    await flush();
    assert.equal(host.stats().live_tasks, slots);
    const errors = pending.map((p) =>
      assert.rejects(p, (e) => e.code === "ERR_WASM_OOM"),
    );
    await assert.rejects(host.run(), (e) => e.code === "ERR_WASM_OOM");
    await Promise.all(errors);
    assert.equal(host.stats().dead, true);
    const raw = join(
      env.CARGO_TARGET_DIR,
      "wasm32-unknown-unknown/release/pool.wasm",
    );
    assert.throws(
      () =>
        run(cli, [
          "build",
          raw,
          "--wit",
          join(project, "wit"),
          "--task-slots",
          String(slots + 1),
          "--out-dir",
          join(project, "bad"),
        ]),
      (e) => String(e.stderr).includes("differs from compiled"),
    );
    run(cli, ["update", "--out-dir", output], project);
    assert.equal(
      JSON.parse(readFileSync(join(output, "build.json"))).task_slots,
      slots,
    );
    report.push({
      slots,
      pool_bytes: slots * 128,
      wasm_bytes: wasm.length,
      initial_linear_bytes: instance.exports.memory.buffer.byteLength,
    });
  }
  assert.ok(report[1].initial_linear_bytes < report[2].initial_linear_bytes);
  for (const value of ["0", "65537", "-1", "x"])
    assert.throws(() => run(cli, ["build", "--task-slots", value], project));
  writeFileSync(
    ".cache/pool-check.json",
    JSON.stringify({ all_passed: true, entries: report }, null, 2) + "\n",
  );
  console.table(report);
} catch (e) {
  writeFileSync(
    ".cache/pool-error.log",
    `${e.stack}\n${e.stdout || ""}\n${e.stderr || ""}`,
  );
  throw Error("Pool check failed; see .cache/pool-error.log");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
