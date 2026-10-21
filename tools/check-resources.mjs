import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { rustEnvironment } from "./rust-toolchain.mjs";
const root = resolve("."),
  cli = process.env.TARABA_LIBRARY_CLI || resolve("target/release/taraba"),
  temp = mkdtempSync(join(tmpdir(), "taraba-resources-"));
const env = {
  ...rustEnvironment(root),
  TARABA_BINDGEN: cli,
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: resolve(".cache/resources-target"),
};
const run = (bin, args, cwd = temp) =>
  execFileSync(bin, args, {
    cwd,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
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
    writeFileSync(
      join(project, "wit/app.wit"),
      `package test:resources; interface handles {resource value {constructor(text:string);read:async func()->string;size:func()->u32;} read:async func(v:borrow<value>)->string;} world app {import io:handles;use handles.{value};export make:async func()->own<value>;export inspect:async func(v:borrow<value>)->string;export length:func(v:borrow<value>)->u32;export consume:async func(v:own<value>)->u32;export hold:async func()->string;}`,
    );
    const lib = join(project, "src/lib.rs"),
      prefix = readFileSync(lib, "utf8").split("include!(")[0];
    writeFileSync(
      lib,
      prefix +
        `include!(concat!(env!("OUT_DIR"),"/bindings.rs"));bindings!();struct App;impl Guest for App {async fn make()->HostResult<HandlesValue>{Ok(imports::io::value("hello 🦀".into()))} async fn inspect(v:Borrowed<HandlesValue>)->HostResult<__taraba_types::alloc::string::String>{v.read().await} fn length(v:Borrowed<HandlesValue>)->u32{v.size()} async fn consume(v:HandlesValue)->HostResult<u32>{drop(v);Ok(7)} async fn hold()->HostResult<__taraba_types::alloc::string::String>{let v=imports::io::value("hello 🦀".into());v.read().await}}export!(App);`,
    );
    run(cli, ["build", "--abort-signal"], project);
    const wasm = readFileSync(join(project, "pkg/app.wasm")),
      info = JSON.parse(readFileSync(join(project, "pkg/build.json")));
    assert.equal(info.runtime_abi, 1);
    const compiled = new WebAssembly.Module(wasm);
    assert.equal(
      WebAssembly.Module.customSections(compiled, "taraba:runtime-abi").length,
      0,
    );
    const { createHost } = await import(
        pathToFileURL(join(project, "pkg/index.js"))
      ),
      module = await WebAssembly.compile(
        readFileSync(join(project, "pkg/app.wasm")),
      );
    let drops = 0,
      release,
      slow = false;
    class Value {
      constructor(text) {
        this.text = text;
      }
      read() {
        return slow
          ? new Promise((r) => (release = () => r(this.text)))
          : Promise.resolve(this.text);
      }
      size() {
        return this.text.length;
      }
      [Symbol.dispose]() {
        drops++;
      }
    }
    const connect = async (factory = createHost, compiledModule = module) => {
      const h = factory({
        bindings: {
          io: {
            value: (text) => new Value(text),
            read: (v) =>
              slow
                ? new Promise((r) => (release = () => r(v.text)))
                : Promise.resolve(v.text),
          },
        },
      });
      h.attach(
        (await WebAssembly.instantiate(compiledModule, h.imports)).exports,
      );
      return h;
    };
    const host = await connect(),
      value = await host.make();
    assert.equal(await host.inspect(value), "hello 🦀");
    assert.equal(await host.length(value), 8);
    assert.equal(drops, 0);
    slow = true;
    const c = new AbortController(),
      p = host.inspect(value, { signal: c.signal }),
      rejected = assert.rejects(p, (e) => e.name === "AbortError");
    await flush();
    assert.throws(
      () => value[Symbol.dispose](),
      (e) => e.code === "RS02",
    );
    c.abort();
    await rejected;
    value[Symbol.dispose]();
    value[Symbol.dispose]();
    assert.equal(drops, 1);
    release();
    await flush();
    slow = false;
    const owned = await host.make();
    assert.equal(await host.consume(owned), 7);
    assert.equal(drops, 2);
    owned[Symbol.dispose]();
    assert.equal(drops, 2);
    slow = true;
    const held = host.hold();
    const closed = assert.rejects(held, (e) => e.code === "RT13");
    await flush();
    host.dispose();
    await closed;
    assert.equal(drops, 3);
    assert.equal(host.stats().live_values, 0);
    release();
    await flush();
    slow = false;
    const first = await connect(),
      second = await connect(),
      foreign = await first.make();
    await assert.rejects(second.inspect(foreign), (e) => e.code === "RS01");
    assert.equal(second.stats().dead, true);
    foreign[Symbol.dispose]();
    first.dispose();
    second.dispose();
    writeFileSync(
      join(project, "test.mts"),
      `import {createHost,type AppBindings,type HandlesValue,type ResourceTypes} from './pkg/index.js';class Value {constructor(public text:string){}read(){return Promise.resolve(this.text)}size(){return this.text.length}[Symbol.dispose](){}} type Resources={HandlesValue:Value};const bindings={io:{value:(text:string)=>new Value(text)}} satisfies AppBindings<Resources>;const host=createHost<Resources>({bindings});const value:HandlesValue=await host.make();const text:string=await host.inspect(value);void text;value[Symbol.dispose]();host.dispose();\n// @ts-expect-error raw host objects are not guest leases\nhost.consume(new Value('x'));\n// @ts-expect-error constructor payload is WIT string\nbindings.io.value(123);`,
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
    // A declared constructor that Rust never calls must add no deployed code.
    const wit = join(project, "wit/app.wit");
    writeFileSync(
      wit,
      readFileSync(wit, "utf8").replace(
        "interface handles {",
        "interface handles {resource unused {constructor(payload:list<u8>);}",
      ),
    );
    run(cli, ["build", "--abort-signal", "--out-dir", "pkg-unused"], project);
    for (const name of ["app.wasm", "index.js", "runtime.mjs"]) {
      assert.equal(
        readFileSync(join(project, "pkg-unused", name)).length,
        readFileSync(join(project, "pkg", name)).length,
        `unused constructor changed ${name}`,
      );
    }
    const { createHost: unusedFactory } = await import(
      pathToFileURL(join(project, "pkg-unused/index.js"))
    );
    const unusedHost = await connect(
      unusedFactory,
      await WebAssembly.compile(
        readFileSync(join(project, "pkg-unused/app.wasm")),
      ),
    );
    const unusedLease = await unusedHost.make();
    assert.equal(await unusedHost.inspect(unusedLease), "hello 🦀");
    assert.equal(await unusedHost.consume(unusedLease), 7);
    unusedHost.dispose();
    console.log(
      `Core resources ${std ? "std" : "no_std"}: constructor factory, async own/borrow, explicit dispose, cancellation, owned Drop, foreign-instance rejection and strict TS passed`,
    );
  }
} catch (e) {
  writeFileSync(
    ".cache/resources-error.log",
    `${e.stack}\n${e.stdout || ""}\n${e.stderr || ""}`,
  );
  throw Error("Resource check failed; see .cache/resources-error.log");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
