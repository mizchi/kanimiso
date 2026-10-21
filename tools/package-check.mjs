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
import { verifyScheduling } from "../tests/support/scheduling.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";
import { verifyWatch } from "./check-watch.mjs";
const root = resolve("."),
  temp = mkdtempSync(join(tmpdir(), "taraba-package-"));
const rustEnv = rustEnvironment(root);
const run = (bin, args, cwd = root, env = rustEnv) =>
  execFileSync(bin, args, {
    cwd,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
const cases = [1, 16, 128, 1024].flatMap((c) => asyncCases(c));
const requireClean = process.argv.includes("--require-clean");
const commit = run("git", ["rev-parse", "HEAD"]).toString().trim();
const result = {
  published: false,
  registry_install_verified: false,
  commit,
  require_clean: requireClean,
  method:
    "Cargo package verification + CLI installation from unpacked .crate + external consumer with registry dependencies patched to unpacked .crate archives",
  packages: [],
  consumers: [],
};
try {
  if (requireClean)
    assert.equal(
      run("git", ["status", "--porcelain"]).toString(),
      "",
      "release verification requires a clean checkout",
    );
  run("cargo", ["fetch", "--locked"]);
  for (const name of [
    "taraba",
    "taraba-allocator",
    "taraba-helpers",
    "taraba-cli",
  ]) {
    const args = [
      "package",
      "--locked",
      "--offline",
      "--allow-dirty",
      "-p",
      name,
      ...(name === "taraba-helpers" ? ["--all-features"] : []),
      ...(name === "taraba-cli" ? [] : ["--target", "wasm32-unknown-unknown"]),
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
    const vcs = JSON.parse(readFileSync(`${pkg}/.cargo_vcs_info.json`));
    if (requireClean) {
      assert.equal(vcs.git.sha1, commit);
      assert.notEqual(vcs.git.dirty, true);
    }
    result.packages.push({
      name,
      bytes: readFileSync(archive).length,
      sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
      verified: true,
      vcs,
    });
  }
  const install = join(temp, "installed");
  const env = {
    ...rustEnv,
    TARABA_BINDGEN: join(install, "bin/taraba"),
    // Cargo archives normalize source mtimes. A shared target can incorrectly
    // reuse an older binary with the same package version. Key it by archive bytes.
    CARGO_TARGET_DIR: resolve(
      ".cache/package-install-target",
      result.packages.find((p) => p.name === "taraba-cli").sha256,
    ),
    TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  };
  run(
    "cargo",
    [
      "install",
      "--locked",
      "--offline",
      "--path",
      `${temp}/taraba-cli-0.1.0`,
      "--root",
      install,
    ],
    temp,
    env,
  );
  const cli = `${install}/bin/taraba`;
  assert.match(run(cli, ["--version"], temp, env).toString(), /0\.1\.0/);
  for (const profile of ["core", "jspi"]) {
    const jspi = profile === "jspi",
      name = `consumer-${profile}`;
    run(
      cli,
      ["new", name, "--no-std", ...(jspi ? [] : ["--future"])],
      temp,
      env,
    );
    const project = `${temp}/${name}`,
      manifest = `${project}/Cargo.toml`;
    let toml = readFileSync(manifest, "utf8");
    assert.ok(!toml.includes("path ="));
    toml += `\n[patch.crates-io]\ntaraba-allocator = {path = ${JSON.stringify(`${temp}/taraba-allocator-0.1.0`)}}\n`;
    if (!jspi)
      toml += `taraba = {path = ${JSON.stringify(`${temp}/taraba-0.1.0`)}}\n`;
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
                "--jspi",
                "--wit",
                "wit",
                "--out-dir",
                `${temp}/invalid-jspi`,
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
            ...(debug ? ["--debug"] : []),
          ],
          project,
          env,
        );
        const beforeUpdate = new Map(
          [
            "app.wasm",
            "index.js",
            "runtime.mjs",
            "index.d.ts",
            "runtime.d.mts",
          ].map((file) => [file, readFileSync(`${out}/${file}`)]),
        );
        run(cli, ["update", "--out-dir", out], project, env);
        run(cli, ["update", "--out-dir", out, "--check"], project, env);
        for (const [file, bytes] of beforeUpdate)
          assert.deepEqual(
            readFileSync(`${out}/${file}`),
            bytes,
            `archived CLI update changed ${profile}/${mode}/${debug}: ${file}`,
          );
        const { createHost } = await import(pathToFileURL(`${out}/index.js`));
        const instantiate = async (source, options) => {
          const host = createHost(options);
          const instance = await WebAssembly.instantiate(source, host.imports);
          host.attach(instance.exports);
          return host;
        };
        if (!debug && mode === "no_std") {
          const explicit = `${temp}/explicit-${profile}`;
          run(
            cli,
            [
              "build",
              raw,
              "--wit",
              "wit",
              "--out-dir",
              explicit,
              jspi ? "--jspi" : "--future",
            ],
            project,
            env,
          );
          for (const file of [
            "app.wasm",
            "index.js",
            "index.d.ts",
            "runtime.mjs",
            "runtime.d.mts",
          ])
            assert.deepEqual(
              readFileSync(`${explicit}/${file}`),
              readFileSync(`${out}/${file}`),
            );
        }
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
          return host.run;
        }, cases);
        assert.equal(
          JSON.parse(readFileSync(`${out}/build.json`)).profile,
          jspi ? "wit-core-jspi" : "wit-core-externref",
        );
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
          await assert.rejects(h.run(7, 9), (e) => e === reason);
          assert.equal(count, stage);
          if (jspi) {
            assert.equal(h.stats().dead, true);
            await assert.rejects(h.run(1, 2), (e) => e === reason);
          } else assert.equal(h.stats().live_values, 0);
        }
        result.consumers.push({
          profile,
          mode,
          debug,
          ...verified,
          scheduling: await verifyScheduling(
            async (add) => {
              const h = await instantiate(module, { bindings: { add } });
              return h.run;
            },
            { serialized: jspi },
          ),
          wasm_bytes: readFileSync(`${out}/app.wasm`).length,
          js_bytes:
            readFileSync(`${out}/index.js`).length +
            readFileSync(`${out}/runtime.mjs`).length,
          rejection_identity_steps: 2,
        });
      }
    }
  }
  result.all_passed = true;
  run(process.execPath, ["tools/check-library.mjs"], root, {
    ...env,
    TARABA_LIBRARY_CLI: cli,
    TARABA_LIBRARY_RUNTIME: `${temp}/taraba-0.1.0`,
    TARABA_LIBRARY_ALLOCATOR: `${temp}/taraba-allocator-0.1.0`,
  });
  result.npm_libraries_verified_from_archived_cli = true;
  run(process.execPath, ["tools/check-insight.mjs"], root, {
    ...env,
    TARABA_LIBRARY_CLI: cli,
    TARABA_LIBRARY_RUNTIME: `${temp}/taraba-0.1.0`,
    TARABA_LIBRARY_ALLOCATOR: `${temp}/taraba-allocator-0.1.0`,
  });
  result.insight_verified_from_archived_cli = true;
  run(process.execPath, ["tools/check-helpers.mjs"], root, {
    ...env,
    TARABA_LIBRARY_CLI: cli,
    TARABA_LIBRARY_RUNTIME: `${temp}/taraba-0.1.0`,
    TARABA_LIBRARY_ALLOCATOR: `${temp}/taraba-allocator-0.1.0`,
    TARABA_LIBRARY_HELPERS: `${temp}/taraba-helpers-0.1.0`,
    TARABA_HELPERS_SMOKE: "1",
  });
  result.helpers_verified_from_archived_cli = true;
  run(process.execPath, ["tools/check-strings.mjs"], root, {
    ...env,
    TARABA_LIBRARY_CLI: cli,
    TARABA_LIBRARY_HELPERS: `${temp}/taraba-helpers-0.1.0`,
    TARABA_LIBRARY_ALLOCATOR: `${temp}/taraba-allocator-0.1.0`,
    TARABA_HELPERS_SMOKE: "1",
  });
  result.strings_verified_from_archived_cli = true;
  result.watch = await verifyWatch(cli, env);
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    ".cache/package-check.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    "Packaged and verified four crates; installed archived CLI; external core/jspi × std/no_std × release/debug and helpers consumers passed. Nothing published.",
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
