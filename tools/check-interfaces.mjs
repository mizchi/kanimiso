import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { rustEnvironment } from "./rust-toolchain.mjs";
const root = resolve("."),
  cli = process.env.TARABA_LIBRARY_CLI || resolve("target/release/taraba");
const temp = mkdtempSync(join(tmpdir(), "taraba-interfaces-"));
const env = {
  ...rustEnvironment(root),
  TARABA_BINDGEN: cli,
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: resolve(".cache/interfaces-target"),
};
const run = (bin, args, cwd = temp) =>
  execFileSync(bin, args, {
    cwd,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
try {
  for (const std of [false, true]) {
    const project = join(temp, std ? "std" : "no-std");
    run(cli, ["new", project, "--future", ...(std ? [] : ["--no-std"])]);
    const manifest = join(project, "Cargo.toml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8") +
        `\n[patch.crates-io]\ntaraba={path=${JSON.stringify(process.env.TARABA_LIBRARY_RUNTIME || resolve("crates/taraba"))}}\ntaraba-allocator={path=${JSON.stringify(process.env.TARABA_LIBRARY_ALLOCATOR || resolve("crates/taraba-allocator"))}}\n`,
    );
    const wit = `package test:interfaces; interface source {record packet {id:u64,label:string,payload:list<u8>} run:async func(v:packet)->packet;} world app {import first:source;import second:source;export api:source;}`;
    writeFileSync(join(project, "wit/app.wit"), wit);
    const lib = join(project, "src/lib.rs"),
      prefix = readFileSync(lib, "utf8").split("include!(")[0];
    writeFileSync(
      lib,
      prefix +
        `include!(concat!(env!("OUT_DIR"),"/bindings.rs"));bindings!();struct App;impl exports::api::Guest for App {async fn run(v:SourcePacket)->HostResult<SourcePacket>{imports::second::run(imports::first::run(v).await?).await}}export!(App);`,
    );
    run(cli, ["build", "--abort-signal"], project);
    const { createHost } = await import(
      pathToFileURL(join(project, "pkg/index.js"))
    );
    const packet = {
        id: 42n,
        label: "注文 🦀",
        payload: new Uint8Array([0, 255]),
      },
      seen = [];
    const host = createHost({
      bindings: {
        first: {
          async run(v, { signal }) {
            assert.equal(signal.aborted, false);
            seen.push("first");
            return { ...v, id: v.id + 1n };
          },
        },
        second: {
          async run(v) {
            seen.push("second");
            return { ...v, label: v.label + "!" };
          },
        },
      },
    });
    host.attach(
      (
        await WebAssembly.instantiate(
          readFileSync(join(project, "pkg/app.wasm")),
          host.imports,
        )
      ).instance.exports,
    );
    assert.deepEqual(await host.api.run(packet), {
      ...packet,
      id: 43n,
      label: packet.label + "!",
    });
    assert.deepEqual(seen, ["first", "second"]);
    host.dispose();
    writeFileSync(
      join(project, "test.mts"),
      `import {createHost,type AppBindings,type SourcePacket} from './pkg/index.js';const bindings={first:{run:async(v:SourcePacket,{signal})=>{signal.throwIfAborted();return v}},second:{run:v=>v}} satisfies AppBindings;const host=createHost({bindings});const value:Promise<SourcePacket>=host.api.run({id:1n,label:'x',payload:[1,2] as const},{signal:new AbortController().signal});void value;host.dispose();\n// @ts-expect-error interfaces preserve namespaces\nhost.run(1);`,
    );
    run(process.execPath, [
      resolve("node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--lib",
      "ES2022,DOM",
      join(project, "test.mts"),
    ]);
    // Renaming a public namespace must reject stale raw Wasm, even with identical types.
    const raw = join(
      env.CARGO_TARGET_DIR,
      "wasm32-unknown-unknown/release",
      `${std ? "std" : "no_std"}.wasm`,
    );
    writeFileSync(
      join(project, "wit/app.wit"),
      wit.replace("export api:", "export other:"),
    );
    assert.throws(
      () =>
        run(cli, [
          "build",
          raw,
          "--wit",
          join(project, "wit"),
          "--out-dir",
          join(project, "bad"),
        ]),
      (e) => String(e.stderr).includes("contract mismatch"),
    );
    // Pure scalar, synchronous interfaces also retain their public namespace.
    writeFileSync(
      join(project, "wit/app.wit"),
      "package test:scalar; interface service {add:func(v:u32)->u32;} world app {import io:service;export api:service;}",
    );
    writeFileSync(
      lib,
      prefix +
        `include!(concat!(env!("OUT_DIR"),"/bindings.rs"));bindings!();struct App;impl exports::api::Guest for App {fn add(v:u32)->u32{imports::io::add(v)}}export!(App);`,
    );
    for (const profile of ["future", "jspi"]) {
      const folder = join(project, `scalar-${profile}`);
      run(cli, ["build", `--${profile}`, "--out-dir", folder], project);
      const scalar = await import(pathToFileURL(join(folder, "index.js")));
      const sync = scalar.createHost({
        bindings: { io: { add: (v) => v + 1 } },
      });
      const bytes = readFileSync(join(folder, "app.wasm"));
      const compiled = await WebAssembly.compile(bytes);
      assert.equal(
        WebAssembly.Module.exports(compiled).some((e) =>
          e.name.startsWith("taraba-iface-"),
        ),
        false,
      );
      sync.attach(
        (await WebAssembly.instantiate(compiled, sync.imports)).exports,
      );
      assert.equal(await sync.api.add(41), 42);
      sync.dispose();
    }
    console.log(
      `Core interfaces ${std ? "std" : "no_std"}: grouped Rust/TS, duplicate methods, async values, AbortSignal and stale contract checks passed`,
    );
  }
} catch (e) {
  writeFileSync(
    ".cache/interfaces-error.log",
    `${e.stack}\n${e.stdout || ""}\n${e.stderr || ""}`,
  );
  throw Error("Interface verification failed; see .cache/interfaces-error.log");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
