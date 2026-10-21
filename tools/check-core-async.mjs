import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { rustEnvironment } from "./rust-toolchain.mjs";
import { verifyWit } from "../tests/support/wit-contract.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";
import { verifyPromiseFailures } from "../experiments/async-size/contract.mjs";

const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const firstBlock = (text, language) => {
  const match = text.match(
    new RegExp("```" + language + "\\n([\\s\\S]*?)\\n```"),
  );
  assert.ok(match, `README is missing its ${language} interface/example`);
  return match[1];
};

export async function verifyCoreAsync({
  cli,
  env,
  runtime = process.env.TARABA_LIBRARY_RUNTIME || resolve("crates/taraba"),
  allocator = process.env.TARABA_LIBRARY_ALLOCATOR ||
    resolve("crates/taraba-allocator"),
}) {
  const temp = mkdtempSync(join(tmpdir(), "taraba-core-async-"));
  const run = (bin, args, cwd = temp) =>
    execFileSync(bin, args, {
      cwd,
      env,
      stdio: "pipe",
      maxBuffer: 32 * 1024 * 1024,
    });
  const patchRuntime = (project) => {
    const manifest = join(project, "Cargo.toml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8") +
        `\n[patch.crates-io]\ntaraba={path=${JSON.stringify(runtime)}}\ntaraba-allocator={path=${JSON.stringify(allocator)}}\n`,
    );
  };
  const en = readFileSync("README.md", "utf8"),
    ja = readFileSync("README.ja.md", "utf8");
  const examples = Object.fromEntries(
    ["wit", "rust", "js"].map((language) => {
      const source = firstBlock(en, language);
      assert.equal(source, firstBlock(ja, language));
      return [language, source];
    }),
  );
  assert.doesNotMatch(
    examples.rust,
    /unsafe|JsPromise|from_abi|into_abi|take_handle/,
  );
  const baseline = JSON.parse(readFileSync("docs/async-size.json"));
  const cases = [1, 16, 128, 1024].flatMap((n) => asyncCases(n));
  const results = [];
  try {
    for (const std of [false, true]) {
      const project = join(temp, std ? "readme-std" : "readme-no-std");
      run(cli, ["new", project, "--future", ...(std ? [] : ["--no-std"])]);
      patchRuntime(project);
      const lib = join(project, "src/lib.rs");
      const prefix = readFileSync(lib, "utf8").split("include!(")[0];
      writeFileSync(lib, prefix + examples.rust + "\n");
      writeFileSync(join(project, "main.mjs"), examples.js + "\n");
      let expected;
      for (const syntax of ["future", "async-func"]) {
        const wit =
          syntax === "future"
            ? examples.wit
            : examples.wit.replaceAll(
                "func(a: s32, b: s32) -> future<s32>",
                "async func(a: s32, b: s32) -> s32",
              );
        writeFileSync(join(project, "wit/app.wit"), wit);
        run(cli, ["build"], project);
        assert.equal(
          run(process.execPath, ["main.mjs"], project).toString().trim(),
          "42",
        );
        const output = join(project, "pkg");
        const wasm = readFileSync(join(output, "app.wasm"));
        const module = await WebAssembly.compile(wasm);
        assert.equal(
          WebAssembly.Module.customSections(module, "taraba:core-wit").length,
          0,
        );
        const bundle = await rolldown({
          input: join(output, "index.js"),
          platform: "neutral",
          transform: { target: "es2022" },
        });
        let generated;
        try {
          generated = await bundle.generate({ format: "esm", minify: true });
        } finally {
          await bundle.close();
        }
        assert.equal(generated.output.length, 1);
        const js = Buffer.from(generated.output[0].code);
        assert.ok(
          js.length <= 3800,
          "documented Core async JS exceeds the 3,800-byte budget",
        );
        const control = baseline.entries.find(
          (e) =>
            e.backend === "future" &&
            e.mode === (std ? "std" : "no_std") &&
            e.workload === "async" &&
            e.allocator === "taraba",
        );
        assert.ok(
          wasm.length <= control.wasm_bytes,
          "README async implementation increased Wasm size",
        );
        assert.ok(
          js.length <= control.js_bytes,
          "README async implementation increased JS size",
        );
        if (expected) {
          assert.deepEqual(
            wasm,
            expected.wasm,
            "future<T> and async func must generate identical Wasm",
          );
          assert.deepEqual(js, expected.js);
        } else {
          expected = { wasm, js };
        }
        const { createHost } = await import(
          pathToFileURL(join(output, "index.js"))
        );
        const connect = async (add) => {
          const host = createHost({ bindings: { add } });
          assert.deepEqual(
            Object.keys(host).sort(),
            [
              "activeTasks",
              "dispose",
              "attach",
              "cancel",
              "imports",
              "run",
              "stats",
            ].sort(),
          );
          host.attach(
            (await WebAssembly.instantiate(module, host.imports)).exports,
          );
          return host;
        };
        const factory = async (add) => (await connect(add)).run;
        const verified = await verifyWit(factory, cases);
        const failure = await verifyPromiseFailures(factory);
        let release;
        const host = await connect((a, b) =>
          release
            ? Promise.resolve((a + b) | 0)
            : new Promise((r) => {
                release = () => r((a + b) | 0);
              }),
        );
        const pending = host.run(20, 21);
        const cancelled = assert.rejects(
          pending,
          (e) => e.name === "AbortError",
        );
        await flush();
        assert.equal(host.stats().live_waits, 1);
        assert.equal(host.cancel(host.activeTasks()[0]), true);
        await cancelled;
        release();
        await flush();
        assert.equal(host.stats().live_waits, 0);
        assert.equal(host.stats().live_tasks, 0);
        assert.equal(host.stats().live_values, 0);
        assert.equal(await host.run(1, 2), 4);
        results.push({
          std,
          syntax,
          wasm_bytes: wasm.length,
          js_bytes: js.length,
          wasm_growth: wasm.length - control.wasm_bytes,
          js_growth: js.length - control.js_bytes,
          ...verified,
          failure,
          cancelled_and_reused: true,
        });
        console.log(
          `Core async README ${std ? "std" : "no_std"}/${syntax}: ${wasm.length} B Wasm + ${js.length} B JS, no growth; ${verified.tasks} cases, rejection identity and cancellation passed`,
        );
      }
    }
    const unit = join(temp, "unit");
    run(cli, ["new", unit, "--future", "--no-std"]);
    patchRuntime(unit);
    const lib = join(unit, "src/lib.rs");
    const prefix = readFileSync(lib, "utf8").split("include!(")[0];
    writeFileSync(
      join(unit, "wit/app.wit"),
      "package test:unit; world app {import wait:func()->future; export run:func()->future; export echo:func(v:u32)->u32; export echo-double:func(v:f64)->f64; export call:func(v:s32)->s32;}",
    );
    writeFileSync(
      lib,
      prefix +
        `include!(concat!(env!("OUT_DIR"),"/bindings.rs")); bindings!(); struct App; impl Guest for App {async fn run()->HostResult<()> {wait().await} fn echo(v:u32)->u32 {v} fn echo_double(v:f64)->f64 {v} fn call(v:i32)->i32 {v}} export!(App);`,
    );
    run(cli, ["build"], unit);
    const { createHost } = await import(
      pathToFileURL(join(unit, "pkg/index.js"))
    );
    const host = createHost({ bindings: { wait: async () => {} } });
    host.attach(
      (
        await WebAssembly.instantiate(
          readFileSync(join(unit, "pkg/app.wasm")),
          host.imports,
        )
      ).instance.exports,
    );
    assert.equal(await host.run(), undefined);
    assert.equal(await host.echo(0xffffffff), 0xffffffff);
    assert.equal(
      await host.call(42),
      42,
      "a declared call export must not recurse into itself",
    );
    for (const value of [NaN, Infinity, -Infinity, -0, 1.25])
      assert.ok(Object.is(await host["echo-double"](value), value));
    assert.equal(host.stats().live_values, 0);
    return { all_passed: true, examples: results, unit_and_sync_scalars: true };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(".");
  const cli =
    process.env.TARABA_LIBRARY_CLI || join(root, "target/release/taraba");
  const env = {
    ...rustEnvironment(root),
    TARABA_BINDGEN: cli,
    TARABA_BINARYEN: join(root, ".cache/toolchains/binaryen-version_133/bin"),
    CARGO_TARGET_DIR: join(root, ".cache/core-async-consumer-target"),
  };
  try {
    writeFileSync(
      ".cache/core-async-check.json",
      JSON.stringify(await verifyCoreAsync({ cli, env }), null, 2) + "\n",
    );
  } catch (e) {
    writeFileSync(
      ".cache/core-async-error.log",
      `${e.stack || e}\n${e.stdout || ""}\n${e.stderr || ""}`,
    );
    throw Error("Core async check failed; see .cache/core-async-error.log");
  }
}
