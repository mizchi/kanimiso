import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { rustEnvironment } from "./rust-toolchain.mjs";
import { verifyWit } from "../tests/support/wit-contract.mjs";
import { verifyScheduling } from "../tests/support/scheduling.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";

const root = resolve(".");
const cli = process.env.TARABA_LIBRARY_CLI || resolve("target/release/taraba");
const runtime = process.env.TARABA_LIBRARY_RUNTIME || resolve("crates/taraba");
const allocator =
  process.env.TARABA_LIBRARY_ALLOCATOR || resolve("crates/taraba-allocator");
const temp = mkdtempSync(join(tmpdir(), "taraba-insight-"));
const env = {
  ...rustEnvironment(root),
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: resolve(".cache/insight-consumer-target"),
};
function run(bin, args, cwd = root) {
  try {
    return execFileSync(bin, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`${bin} ${args.join(" ")}\n${e.stderr}`, { cause: e });
  }
}
const batches = [1, 16, 128, 1024].flatMap((n) => asyncCases(n));
const report = { cases: [], safari_browser_verified: false };
try {
  for (const profile of ["jspi", "future"]) {
    const project = join(temp, `insight-${profile}`);
    run(cli, ["new", project, "--no-std", `--${profile}`]);
    const manifest = join(project, "Cargo.toml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8") +
        `\n[patch.crates-io]\ntaraba-allocator={path=${JSON.stringify(allocator)}}\n${profile === "future" ? `taraba={path=${JSON.stringify(runtime)}}\n` : ""}`,
    );
    const wit = join(project, "wit/app.wit");
    writeFileSync(
      wit,
      readFileSync(wit, "utf8").replace(
        /}\s*$/,
        "    export formatted: func(n: s32) -> s32;\n}\n",
      ),
    );
    const source = join(project, "src/lib.rs");
    writeFileSync(
      source,
      readFileSync(source, "utf8")
        .replace(
          "#[global_allocator]",
          "extern crate alloc;\n#[global_allocator]",
        )
        .replace(
          "impl Guest for App {",
          'impl Guest for App {\n    fn formatted(n: i32) -> i32 { alloc::format!("value={n}").len() as i32 }',
        ),
    );
    for (const std of [false, true]) {
      const mode = std ? "std" : "no_std";
      const baseline = join(project, `baseline-${mode}`),
        output = join(project, `pkg-${mode}`);
      const flags = std ? ["--features", "std"] : [];
      const quiet = spawnSync(
        cli,
        ["build", "--no-size-warnings", "--out-dir", baseline, ...flags],
        { cwd: project, env, encoding: "utf8" },
      );
      assert.equal(quiet.status, 0, quiet.stderr);
      assert.ok(!quiet.stderr.includes("warning[taraba::fmt-"));
      const warning = spawnSync(
        cli,
        [
          "build",
          "--insight",
          "--out-dir",
          output,
          "--npm-name",
          `@taraba-insight/${profile}-${mode}`,
          "--license",
          "MIT",
          ...flags,
        ],
        { cwd: project, env, encoding: "utf8" },
      );
      assert.equal(warning.status, 0, warning.stderr);
      assert.match(
        warning.stderr,
        /warning\[taraba::fmt-size\].*lib\.rs:\d+:\d+: format! may retain/,
      );
      assert.match(warning.stderr, /warning\[taraba::fmt-linked\]/);
      const inspection = JSON.parse(
        run(cli, ["insight", output, "--json", "--paths", "fmt"]),
      );
      assert.ok(inspection.functions.length > 0);
      assert.ok(
        inspection.functions.some(
          (f) => f.group === "formatting" && f.path.length > 0,
        ),
      );
      assert.equal(
        inspection.deployment_bytes,
        readFileSync(join(output, "app.wasm")).length,
      );
      const build = JSON.parse(readFileSync(join(output, "build.json")));
      assert.equal(build.npm.packaged_wasm_bytes, inspection.deployment_bytes);
      const manifest = JSON.parse(readFileSync(join(output, "package.json")));
      assert.ok(!manifest.files.some((f) => f.startsWith(".taraba/")));
      const pack = join(project, `pack-${mode}`);
      mkdirSync(pack);
      run("pnpm", ["pack", "--pack-destination", pack], output);
      const archive = join(
        pack,
        readdirSync(pack).find((f) => f.endsWith(".tgz")),
      );
      assert.ok(!run("tar", ["-tzf", archive]).includes(".taraba/"));
      for (const directory of [baseline, output]) {
        const { createHost } = await import(
          pathToFileURL(join(directory, "index.js"))
        );
        const bytes = readFileSync(join(directory, "app.wasm"));
        const instantiate = async (add) => {
          const host = createHost({ bindings: { add } });
          const { instance } = await WebAssembly.instantiate(
            bytes,
            host.imports,
          );
          host.attach(instance.exports);
          return host;
        };
        const factory = async (add) => {
          const host = await instantiate(add);
          return (...args) => host.run(...args);
        };
        const cases = await verifyWit(factory, batches);
        assert.equal(cases.tasks, 3507);
        await verifyScheduling(factory, { serialized: profile === "jspi" });
        const host = await instantiate(async (a, b) => (a + b) | 0);
        for (const n of [0, 42, -2147483648, 2147483647])
          assert.equal(await host.formatted(n), `value=${n}`.length);
      }
      // Stored names must describe these exact bytes, not an older build.
      writeFileSync(
        join(output, "app.wasm"),
        readFileSync(join(output, "app.wasm")).subarray(0, 8),
      );
      const stale = spawnSync(cli, ["insight", output, "--json"], {
        env,
        encoding: "utf8",
      });
      assert.notEqual(stale.status, 0);
      assert.match(stale.stderr, /stale/);
      report.cases.push({
        profile,
        mode,
        shared_cases_per_variant: 3507,
        formatting_bytes: inspection.groups.formatting,
        analysis_excluded_from_npm: true,
        stale_rejected: true,
      });
      console.log(
        `insight ${profile}/${mode}: warnings, optimized names, 3507 cases × baseline/analysis, npm exclusion and stale detection passed`,
      );
    }
  }
  report.all_passed = true;
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    ".cache/insight-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
