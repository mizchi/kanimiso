import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rustEnvironment } from "./rust-toolchain.mjs";

const root = resolve("."),
  cli = process.env.TARABA_LIBRARY_CLI || resolve("target/release/taraba"),
  temp = mkdtempSync(join(tmpdir(), "taraba-legacy-abi-")),
  project = join(temp, "legacy"),
  env = {
    ...rustEnvironment(root),
    CARGO_TARGET_DIR: resolve(".cache/runtime-abi-target"),
    TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  };
const run = (args, cwd = project) =>
  spawnSync(cli, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
try {
  const created = run(["new", project, "--future", "--no-std"], temp);
  assert.equal(created.status, 0, created.stderr);
  // Use the real published runtime, not a fabricated marker or a workspace patch.
  // Pin exactly: a later compatible patch must not silently replace this control.
  const manifest = join(project, "Cargo.toml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(
      'taraba = {version = "0.1.0"',
      'taraba = {version = "=0.1.0"',
    ),
  );
  const output = join(project, "pkg");
  mkdirSync(output);
  writeFileSync(
    join(output, "build.json"),
    JSON.stringify({ builder: "0.1.0", profile: "wit-core-externref" }),
  );
  writeFileSync(join(output, "index.js"), "previous output");
  // A failed upgrade must preserve an existing generated directory.
  const legacy = run(["build"]);
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /missing taraba runtime ABI/);
  assert.doesNotMatch(legacy.stderr, /cargo build failed/);
  // Cargo normalizes package names to lowercase; read its selected package name.
  const packageName = readFileSync(manifest, "utf8")
    .match(/name = "([^"]+)"/)[1]
    .replaceAll("-", "_");
  const raw = join(
    env.CARGO_TARGET_DIR,
    "wasm32-unknown-unknown/release",
    `${packageName}.wasm`,
  );
  assert.ok(readFileSync(raw).length > 0);
  const retried = run(["build", raw, "--future", "--wit", "wit"]);
  assert.notEqual(retried.status, 0);
  assert.match(retried.stderr, /missing taraba runtime ABI/);
  assert.equal(
    readFileSync(join(output, "index.js"), "utf8"),
    "previous output",
  );
  writeFileSync(
    resolve(".cache/runtime-abi-check.json"),
    JSON.stringify(
      {
        cli: run(["--version"]).stdout.trim(),
        legacy_runtime: "=0.1.0",
        expected_revision: 1,
        rejected_project: true,
        rejected_raw_wasm: true,
        previous_output_preserved: true,
        all_passed: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "runtime ABI: published 0.1.0 is rejected by Cargo and raw-Wasm builds despite the matching SemVer line",
  );
} catch (error) {
  writeFileSync(resolve(".cache/runtime-abi-error.log"), error.stack);
  throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
