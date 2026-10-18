import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { rustEnvironment } from "./rust-toolchain.mjs";
import { verifyWit } from "../tests/support/wit-contract.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";
const root = resolve("."),
  temp = mkdtempSync(join(tmpdir(), "kanimiso-package-"));
const rustEnv = rustEnvironment(root);
const run = (bin, args, cwd = root, env = rustEnv) =>
  execFileSync(bin, args, {
    cwd,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
const cases = [1, 16, 128, 1024].flatMap((c) => asyncCases(c));
const result = {
  published: false,
  registry_install_verified: false,
  method:
    "Cargo package verification + CLI installation from unpacked .crate + external consumer with registry dependencies patched to unpacked .crate archives",
  packages: [],
  consumers: [],
};
try {
  run("cargo", ["fetch", "--locked"]);
  for (const name of ["kanimiso", "kanimiso-allocator", "kanimiso-cli"]) {
    const args = [
      "package",
      "--locked",
      "--offline",
      "--allow-dirty",
      "-p",
      name,
      ...(name === "kanimiso-cli"
        ? []
        : ["--target", "wasm32-unknown-unknown"]),
    ];
    run("cargo", args);
    const archive = resolve(`target/package/${name}-0.1.0.crate`);
    run("tar", ["-xzf", archive, "-C", temp]);
    const pkg = join(temp, `${name}-0.1.0`),
      manifest = readFileSync(`${pkg}/Cargo.toml`, "utf8");
    assert.ok(
      !manifest.includes('path = "../../'),
      `${name} must not require repository paths`,
    );
    assert.ok(readFileSync(`${pkg}/LICENSE`).length > 0);
    result.packages.push({
      name,
      bytes: readFileSync(archive).length,
      sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
      verified: true,
    });
  }
  const install = join(temp, "installed");
  const env = {
    ...rustEnv,
    // Cargo archives normalize source mtimes. A shared target can incorrectly
    // reuse an older binary with the same package version. Key it by archive bytes.
    CARGO_TARGET_DIR: resolve(
      ".cache/package-install-target",
      result.packages.find((p) => p.name === "kanimiso-cli").sha256,
    ),
    KANIMISO_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  };
  run(
    "cargo",
    [
      "install",
      "--locked",
      "--offline",
      "--path",
      `${temp}/kanimiso-cli-0.1.0`,
      "--root",
      install,
    ],
    temp,
    env,
  );
  const cli = `${install}/bin/kanimiso`;
  assert.match(run(cli, ["--version"], temp, env).toString(), /0\.1\.0/);
  for (const profile of ["core", "jspi"]) {
    const jspi = profile === "jspi",
      name = `consumer-${profile}`;
    run(cli, ["new", name, "--no-std", ...(jspi ? ["--jspi"] : [])], temp, env);
    const project = `${temp}/${name}`,
      manifest = `${project}/Cargo.toml`;
    let toml = readFileSync(manifest, "utf8");
    assert.ok(!toml.includes("path ="));
    toml += `\n[patch.crates-io]\nkanimiso-allocator = {path = ${JSON.stringify(`${temp}/kanimiso-allocator-0.1.0`)}}\n`;
    if (!jspi)
      toml += `kanimiso = {path = ${JSON.stringify(`${temp}/kanimiso-0.1.0`)}}\n`;
    writeFileSync(manifest, toml);
    run("cargo", ["fetch", "--manifest-path", manifest], project, env);
    for (const mode of ["no_std", "std"]) {
      run(
        "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "--release",
          "--target",
          "wasm32-unknown-unknown",
          ...(mode === "std" ? ["--features", "std"] : []),
        ],
        project,
        { ...env, CARGO_TARGET_DIR: `${temp}/consumer-target` },
      );
      const raw = `${temp}/consumer-target/wasm32-unknown-unknown/release/${name.replaceAll("-", "_")}.wasm`;
      if (!jspi)
        assert.throws(
          () =>
            run(
              cli,
              [
                "build",
                raw,
                "--wit",
                "wit",
                "--out-dir",
                `${temp}/invalid-jspi`,
                "--jspi",
              ],
              project,
              env,
            ),
          (e) => String(e.stderr).includes("scalar WIT"),
        );
      for (const debug of [false, true]) {
        const out = `${temp}/pkg-${profile}-${mode}-${debug ? "debug" : "release"}`;
        run(
          cli,
          [
            "build",
            raw,
            "--wit",
            "wit",
            "--out-dir",
            out,
            ...(jspi ? ["--jspi"] : []),
            ...(debug ? ["--debug"] : []),
          ],
          project,
          env,
        );
        const { instantiate } = await import(
          pathToFileURL(`${out}/kanimiso.mjs`)
        );
        const module = new WebAssembly.Module(readFileSync(`${out}/app.wasm`));
        assert.ok(
          WebAssembly.Module.exports(module).every(
            (e) => !e.name.startsWith("cabi_realloc"),
          ),
          "Core output must remove generated canonical realloc exports",
        );
        if (jspi)
          assert.ok(
            WebAssembly.Module.imports(module).every((i) => i.module === "app"),
          );
        let host;
        const verified = await verifyWit(async (add) => {
          host = await instantiate(module, { bindings: { add } });
          return (...a) => host.promise("run", ...a);
        }, cases);
        const stats = host.stats();
        assert.equal(stats.dead, false);
        if (jspi) assert.equal(stats.queued, 0);
        else
          assert.equal(
            stats.live_tasks + stats.live_waits + stats.live_values,
            0,
          );
        for (const stage of [1, 2]) {
          const reason = { stage };
          let count = 0;
          const h = await instantiate(module, {
            bindings: {
              add: (a, b) =>
                ++count === stage
                  ? Promise.reject(reason)
                  : Promise.resolve((a + b) | 0),
            },
          });
          await assert.rejects(h.promise("run", 7, 9), (e) => e === reason);
          assert.equal(count, stage);
          if (jspi) {
            assert.equal(h.stats().dead, true);
            await assert.rejects(h.promise("run", 1, 2), (e) => e === reason);
          } else assert.equal(h.stats().live_values, 0);
        }
        result.consumers.push({
          profile,
          mode,
          debug,
          ...verified,
          wasm_bytes: readFileSync(`${out}/app.wasm`).length,
          js_bytes: readFileSync(`${out}/kanimiso.mjs`).length,
          rejection_identity_steps: 2,
        });
      }
    }
  }
  result.all_passed = true;
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    ".cache/package-check.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    "Packaged and verified three crates; installed archived CLI; external core/jspi × std/no_std × release/debug consumers passed. Nothing published.",
  );
} catch (e) {
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    ".cache/package-check-error.log",
    String(e.stderr || e.stack || e),
  );
  throw Error("Package check failed; see .cache/package-check-error.log");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
