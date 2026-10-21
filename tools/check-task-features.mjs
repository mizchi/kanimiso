import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { rustEnvironment } from "./rust-toolchain.mjs";
import { verifyWatchOutput } from "./check-watch.mjs";

const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
async function deadline(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function verifyTaskFeatures({
  cli,
  env,
  runtime = resolve("crates/taraba"),
  allocator = resolve("crates/taraba-allocator"),
}) {
  const temp = mkdtempSync(join(tmpdir(), "taraba-task-features-"));
  const run = (bin, args, cwd = temp) =>
    execFileSync(bin, args, {
      cwd,
      env,
      stdio: "pipe",
      maxBuffer: 32 * 1024 * 1024,
    });
  const report = [];
  try {
    for (const std of [false, true]) {
      const project = join(temp, std ? "std" : "no-std");
      run(cli, ["new", project, "--future", ...(std ? [] : ["--no-std"])]);
      const manifest = join(project, "Cargo.toml");
      writeFileSync(
        manifest,
        readFileSync(manifest, "utf8") +
          `\n[patch.crates-io]\ntaraba={path=${JSON.stringify(runtime)}}\ntaraba-allocator={path=${JSON.stringify(allocator)}}\n`,
      );
      // The old arithmetic frame remains inline after adding the Box fallback.
      run(cli, ["build"], project);
      const small = readFileSync(join(project, "pkg/app.wasm")).length;
      const baseline = JSON.parse(
        readFileSync("docs/async-size.json"),
      ).entries.find(
        (e) =>
          e.backend === "future-typed" &&
          e.mode === (std ? "std" : "no_std") &&
          e.workload === "async" &&
          e.allocator === "taraba",
      );
      assert.ok(
        small <= baseline.wasm_bytes,
        `small Future grew: ${small} > ${baseline.wasm_bytes}`,
      );
      const prefix = readFileSync(join(project, "src/lib.rs"), "utf8").split(
        "include!(",
      )[0];
      writeFileSync(
        join(project, "wit/app.wit"),
        `package test:tasks; world app { import wait: async func(id:u32)->u32; import disposed:func(id:u32); export run:async func(id:u32)->u32; }`,
      );
      writeFileSync(
        join(project, "src/lib.rs"),
        prefix +
          `
include!(concat!(env!("OUT_DIR"),"/bindings.rs")); bindings!();
#[repr(align(256))] struct Payload([u8;512]);
struct Guard(u32); impl Drop for Guard {fn drop(&mut self) {disposed(self.0)}}
struct App; impl Guest for App {
 async fn run(id:u32)->HostResult<u32> {
  let guard=Guard(id);
  let mut data=Payload([id as u8;512]);
  core::hint::black_box(&mut data);
  let result=wait(id).await;
  core::hint::black_box(&mut data);
  assert_eq!(data.0[511], id as u8);
  drop(guard); result
 }
} export!(App);`,
      );
      run(cli, ["build"], project);
      const ordinary = readFileSync(join(project, "pkg/app.wasm"));
      const runtimeBytes = readFileSync(
        join(project, "pkg/runtime.mjs"),
      ).length;
      run(cli, ["build", "--abort-signal", "--out-dir", "abort-pkg"], project);
      if (!std)
        await verifyWatchOutput(
          cli,
          ["build", "--abort-signal", "--watch", "--out-dir", "watch-pkg"],
          {
            cwd: project,
            env,
            expected: join(project, "abort-pkg"),
            output: join(project, "watch-pkg"),
          },
        );
      assert.ok(
        runtimeBytes <= 3680,
        "unused AbortSignal support increased the ordinary runtime",
      );
      const wasm = readFileSync(join(project, "abort-pkg/app.wasm"));
      assert.deepEqual(wasm, ordinary, "AbortSignal must add zero Wasm bytes");
      const { createHost } = await import(
        pathToFileURL(join(project, "abort-pkg/index.js"))
      );
      const module = await WebAssembly.compile(wasm);
      const connect = async (bindings) => {
        const host = createHost({ bindings });
        host.attach(
          (await WebAssembly.instantiate(module, host.imports)).exports,
        );
        return host;
      };
      const drops = [],
        pending = new Map(),
        signals = new Map();
      const host = await connect({
        wait(id, { signal }) {
          signals.set(id, signal);
          return new Promise((r) => pending.set(id, r));
        },
        disposed(id) {
          drops.push(id);
        },
      });
      const a = new AbortController(),
        b = new AbortController(),
        reason = { stop: true };
      const p = host.run(1, { signal: a.signal }),
        q = host.run(2, { signal: b.signal });
      const rejected = assert.rejects(p, (e) => e === reason);
      await flush();
      assert.equal(host.stats().live_tasks, 2);
      a.abort(reason);
      await rejected;
      assert.equal(signals.get(1).reason, reason);
      assert.equal(signals.get(2).aborted, false);
      pending.get(1)(99);
      pending.get(2)(42);
      assert.equal(await q, 42);
      await flush();
      assert.deepEqual(drops.sort(), [1, 2]);
      for (let i = 3; i < 103; i++) {
        const p = host.run(i);
        await flush();
        pending.get(i)(i);
        assert.equal(await p, i);
      }
      assert.equal(new Set(drops).size, 102);
      assert.equal(drops.length, 102);
      assert.equal(host.stats().live_values, 0);
      assert.equal(host.stats().live_tasks, 0);
      assert.equal(host.stats().live_waits, 0);
      const abandoned = host.run(103);
      const disposed = assert.rejects(abandoned, (e) => e.code === "RT13");
      await flush();
      host.dispose();
      await disposed;
      assert.equal(drops.filter((id) => id === 103).length, 1);
      assert.equal(host.stats().dead, true);
      assert.equal(
        host.stats().live_values +
          host.stats().live_tasks +
          host.stats().live_waits,
        0,
      );
      // Real fetch I/O receives the scope's signal, rather than merely abandoning a subscription.
      let arrived;
      const arrival = new Promise((r) => (arrived = r)),
        sockets = new Set();
      const server = createServer((req) => arrived(req));
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      try {
        const io = await connect({
          wait: async (id, { signal }) => {
            await fetch(`http://127.0.0.1:${server.address().port}/${id}`, {
              signal,
            });
            return id;
          },
          disposed() {},
        });
        const c = new AbortController(),
          request = io.run(201, { signal: c.signal });
        const reject = assert.rejects(request, (e) => e === reason);
        const req = await deadline(arrival, "HTTP request arrival");
        const closed = new Promise((r) => req.on("close", r));
        c.abort(reason);
        await reject;
        await deadline(closed, "aborted HTTP connection close");
        await flush();
        assert.equal(io.stats().live_tasks, 0);
        assert.equal(io.stats().live_waits, 0);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((r) => server.close(r));
      }
      writeFileSync(
        join(project, "types.mts"),
        `import {createHost,type HostContext,type CallOptions} from './abort-pkg/index.js';
const host=createHost({bindings:{wait:async(id,{signal}:HostContext)=>{signal.throwIfAborted();return id},disposed:(_id,context)=>{context.signal.throwIfAborted()}}});
const options:CallOptions={signal:new AbortController().signal};
const output:Promise<number>=host.run(1,options); void output;
// @ts-expect-error signal is an AbortSignal
host.run(1,{signal:42});
`,
      );
      run(process.execPath, [
        resolve("node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--lib",
        "ES2022,DOM",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        join(project, "types.mts"),
      ]);
      // update retains the opt-in and regenerates the same Wasm/runtime pair.
      run(cli, ["update", "--out-dir", "abort-pkg"], project);
      assert.equal(
        JSON.parse(readFileSync(join(project, "abort-pkg/build.json")))
          .abort_signal,
        true,
      );
      report.push({
        std,
        small_wasm_bytes: small,
        large_wasm_bytes: wasm.length,
        ordinary_runtime_bytes: runtimeBytes,
        abort_runtime_bytes: readFileSync(
          join(project, "abort-pkg/runtime.mjs"),
        ).length,
        abort_wasm_growth: 0,
        large_future_drop_once: true,
        fetch_aborted: true,
        strict_types: true,
      });
      console.log(
        `Task features ${std ? "std" : "no_std"}: small ${small} B, boxed ${wasm.length} B, cancellation/fetch/TS passed`,
      );
    }
    return report;
  } catch (e) {
    writeFileSync(
      ".cache/task-features-error.log",
      `${e.stack || e}\n${e.stdout || ""}\n${e.stderr || ""}`,
    );
    throw Error(
      "Task feature check failed; see .cache/task-features-error.log",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const cli =
    process.env.TARABA_LIBRARY_CLI || resolve("target/release/taraba");
  const env = {
    ...rustEnvironment(resolve(".")),
    TARABA_BINDGEN: cli,
    TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
    CARGO_TARGET_DIR: resolve(".cache/task-features-target"),
  };
  writeFileSync(
    ".cache/task-features.json",
    JSON.stringify(await verifyTaskFeatures({ cli, env }), null, 2) + "\n",
  );
}
