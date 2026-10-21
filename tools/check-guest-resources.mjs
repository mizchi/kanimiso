import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  guestResourceWit,
  guestResourceRust,
} from "../tests/support/guest-resources.mjs";
import { rustEnvironment } from "./rust-toolchain.mjs";
const root = resolve("."),
  cli = process.env.TARABA_LIBRARY_CLI || resolve("target/release/taraba"),
  temp = mkdtempSync(join(tmpdir(), "taraba-guest-resources-"));
const env = {
  ...rustEnvironment(root),
  TARABA_BINDGEN: cli,
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: resolve(".cache/guest-resources-target"),
};
const run = (bin, args, cwd = temp) =>
  execFileSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
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
    writeFileSync(join(project, "wit/app.wit"), guestResourceWit);
    const lib = join(project, "src/lib.rs"),
      prefix = readFileSync(lib, "utf8").split("include!(")[0];
    writeFileSync(lib, prefix + guestResourceRust);
    run(cli, ["build", "--abort-signal"], project);
    const { createHost } = await import(
      pathToFileURL(join(project, "pkg/index.js"))
    );
    let release,
      slow = false,
      duringTick,
      duringDrop;
    const connect = async () => {
      const host = createHost({
        bindings: {
          notify: (phase) => duringDrop?.(phase),
          tick: () => {
            if (duringTick) return duringTick();
            return slow
              ? new Promise((r) => (release = r))
              : Promise.resolve(0);
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
      return host;
    };
    const host = await connect(),
      value = await host.api.counter(7);
    assert.equal(await value.add(2), 9);
    assert.equal(await value.read(), 9);
    assert.equal(await value.wait(), 9);
    assert.equal(await host.api.hold(value), 9);
    assert.equal(await host.api.drops(), 0);
    slow = true;
    const c = new AbortController(),
      pending = value.wait({ signal: c.signal }),
      rejected = assert.rejects(pending, (e) => e.name === "AbortError");
    await flush();
    assert.throws(
      () => value[Symbol.dispose](),
      (e) => e.code === "RS02",
    );
    c.abort();
    await rejected;
    value[Symbol.dispose]();
    value[Symbol.dispose]();
    assert.equal(await host.api.drops(), 1);
    release(0);
    await flush();
    slow = false;
    const moved = await host.api.counter(42);
    assert.equal(await host.api.consume(moved), 42);
    moved[Symbol.dispose]();
    assert.equal(await host.api.drops(), 2);
    const wrongTypeHost = await connect();
    const token = await wrongTypeHost.api.token();
    assert.equal(await token.read(), 77);
    await assert.rejects(
      wrongTypeHost.api.consume(token),
      (e) => e.code === "RS01",
    );
    token[Symbol.dispose]();
    wrongTypeHost.dispose();
    const second = await connect(),
      foreign = await host.api.counter(1);
    await assert.rejects(second.api.consume(foreign), (e) => e.code === "RS01");
    foreign[Symbol.dispose]();
    second.dispose();
    const alive = await host.api.counter(4);
    slow = true;
    const p = alive.wait(),
      closed = assert.rejects(p, (e) => e.code === "RT13");
    await flush();
    host.dispose();
    await closed;
    alive[Symbol.dispose]();
    release(0);
    await flush();
    assert.equal(
      host.stats().live_values +
        host.stats().live_tasks +
        host.stats().live_waits,
      0,
    );
    slow = false;
    const nestedHost = await connect(),
      nested = await nestedHost.api.counter(5);
    duringTick = () => nested.add(1);
    assert.equal(await nested.wait(), 6);
    duringTick = undefined;
    nested[Symbol.dispose]();
    nestedHost.dispose();
    const reentrant = await connect(),
      reentrantValue = await reentrant.api.counter(5);
    // Shutdown invoked synchronously by a host import while the Future is polling.
    duringTick = () => reentrant.dispose();
    await assert.rejects(reentrantValue.wait(), (e) => e.code === "RT13");
    await flush();
    assert.equal(reentrant.stats().dead, true);
    assert.equal(reentrant.stats().live_values, 0);
    reentrantValue[Symbol.dispose]();
    duringTick = undefined;
    const dropHost = await connect(),
      dropValue = await dropHost.api.counter(9),
      phases = [];
    duringDrop = (phase) => {
      phases.push([phase, dropHost.stats().dead]);
      if (phase === 0) dropHost.dispose();
    };
    // Fields including the JS root must finish dropping before shutdown poisons the runtime.
    assert.throws(
      () => dropValue[Symbol.dispose](),
      (e) => e.code === "RT13",
    );
    assert.deepEqual(phases, [
      [0, false],
      [1, false],
    ]);
    assert.equal(dropHost.stats().dead, true);
    assert.equal(dropHost.stats().live_values, 0);
    duringDrop = undefined;
    const fatal = await connect(),
      doomed = await fatal.api.counter(6);
    await assert.rejects(doomed.crash(), WebAssembly.RuntimeError);
    assert.equal(fatal.stats().dead, true);
    doomed[Symbol.dispose]();
    fatal.dispose();
    writeFileSync(
      join(project, "test.mts"),
      `import{createHost,type CountersCounter}from'./pkg/index.js';const host=createHost({bindings:{notify:()=>{},tick:async()=>0}});const value:CountersCounter=await host.api.counter(1);const n:number=await value.add(2);await value.wait({signal:new AbortController().signal});value[Symbol.dispose]();\n// @ts-expect-error resources of different WIT types cannot be interchanged\nhost.api.consume(await host.api.token());\n// @ts-expect-error wrong method argument\nvalue.add('bad');\n// @ts-expect-error receiver method is not a freestanding API\nhost.api.add(1);\n// @ts-expect-error no raw destructor API\nhost['taraba-resource-drop-0'](1);\n`,
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
    if (!std) {
      const packs = join(temp, "packs"),
        consumer = join(temp, "consumer");
      mkdirSync(packs);
      mkdirSync(consumer);
      const pkg = join(project, "pkg");
      const name = JSON.parse(readFileSync(join(pkg, "package.json"))).name;
      run("pnpm", ["pack", "--pack-destination", packs], pkg);
      // Do not let pnpm init select a different packageManager version before
      // the offline install; use the runner's already-installed pnpm.
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ private: true, type: "module" }),
      );
      run(
        "pnpm",
        [
          "add",
          "--offline",
          join(
            packs,
            readdirSync(packs).find((f) => f.endsWith(".tgz")),
          ),
        ],
        consumer,
      );
      writeFileSync(
        join(consumer, "test.mts"),
        readFileSync(join(project, "test.mts"), "utf8").replace(
          "'./pkg/index.js'",
          JSON.stringify(name),
        ),
      );
      for (const flags of [
        ["--module", "NodeNext"],
        ["--module", "ESNext", "--moduleResolution", "bundler"],
      ]) {
        run(process.execPath, [
          resolve("node_modules/typescript/bin/tsc"),
          "--strict",
          "--exactOptionalPropertyTypes",
          "--noUncheckedIndexedAccess",
          "--verbatimModuleSyntax",
          "--noEmit",
          "--target",
          "ES2022",
          ...flags,
          join(consumer, "test.mts"),
        ]);
      }
      writeFileSync(
        join(consumer, "smoke.mjs"),
        `import {createHost} from ${JSON.stringify(name)};export {createHost};`,
      );
      const installed = await import(
        pathToFileURL(join(consumer, "smoke.mjs"))
      );
      const h = installed.createHost({
        bindings: { notify: () => {}, tick: async () => 0 },
      });
      h.attach(
        (
          await WebAssembly.instantiate(
            readFileSync(join(pkg, "app.wasm")),
            h.imports,
          )
        ).instance.exports,
      );
      const c = await h.api.counter(8);
      assert.equal(await c.add(1), 9);
      c[Symbol.dispose]();
      h.dispose();
    }
    console.log(
      `Guest resources ${std ? "std" : "no_std"}: constructor, stateful sync/async methods, own/borrow, cancellation, Drop, instance identity, host shutdown and TS passed`,
    );
  }
  // Compile the exact bilingual guide snippets as an external no_std app.
  const snippets = readFileSync(resolve("docs/resources.md"), "utf8");
  const block = (text, language) =>
    text.match(new RegExp("```" + language + "\\n([\\s\\S]*?)```"))[1];
  const japanese = readFileSync(resolve("docs/resources.ja.md"), "utf8");
  for (const language of ["wit", "rust", "ts"])
    assert.equal(block(snippets, language), block(japanese, language));
  const docsProject = join(temp, "docs");
  run(cli, ["new", docsProject, "--future", "--no-std"]);
  const manifest = join(docsProject, "Cargo.toml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8") +
      `\n[patch.crates-io]\ntaraba={path=${JSON.stringify(process.env.TARABA_LIBRARY_RUNTIME || resolve("crates/taraba"))}}\ntaraba-allocator={path=${JSON.stringify(process.env.TARABA_LIBRARY_ALLOCATOR || resolve("crates/taraba-allocator"))}}\n`,
  );
  writeFileSync(join(docsProject, "wit/app.wit"), block(snippets, "wit"));
  const lib = join(docsProject, "src/lib.rs");
  writeFileSync(
    lib,
    readFileSync(lib, "utf8").split("include!(")[0] + block(snippets, "rust"),
  );
  run(cli, ["build"], docsProject);
  const { createHost } = await import(
    pathToFileURL(join(docsProject, "pkg/index.js"))
  );
  const host = createHost({ bindings: { tick: async () => {} } });
  host.attach(
    (
      await WebAssembly.instantiate(
        readFileSync(join(docsProject, "pkg/app.wasm")),
        host.imports,
      )
    ).instance.exports,
  );
  const value = await host.api.counter(7);
  assert.equal(await value.add(2), 9);
  assert.equal(await value.wait(), 9);
  assert.equal(await host.api.consume(value), 9);
  value[Symbol.dispose]();
  host.dispose();
  writeFileSync(join(docsProject, "test.mts"), block(snippets, "ts"));
  run(process.execPath, [
    resolve("node_modules/typescript/bin/tsc"),
    "--strict",
    "--noEmit",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    join(docsProject, "test.mts"),
  ]);
  console.log("EN/JA resource guide: WIT, Rust and strict TS snippets passed");
  // A stateful library with only synchronous methods needs no Future executor.
  writeFileSync(
    join(docsProject, "wit/app.wit"),
    `package test:sync-resource; interface counters {resource counter {constructor(start:u32);read:func()->u32;}} world app {export api:counters;}`,
  );
  writeFileSync(
    lib,
    readFileSync(lib, "utf8").split("include!(")[0] +
      `include!(concat!(env!("OUT_DIR"),"/bindings.rs"));bindings!(App);pub struct App;pub struct Counter(u32);impl exports::api::Guest for App{type Counter=Counter;}impl exports::api::GuestCounter for Counter{fn new(start:u32)->Self{Self(start)}fn read(&self)->u32{self.0}}export!(App);`,
  );
  run(cli, ["build", "--out-dir", "pkg-sync"], docsProject);
  const syncPkg = join(docsProject, "pkg-sync"),
    syncModule = await WebAssembly.compile(
      readFileSync(join(syncPkg, "app.wasm")),
    );
  assert.ok(
    WebAssembly.Module.exports(syncModule).every(
      (e) => !e.name.startsWith("rt_"),
    ),
  );
  const { createHost: syncHost } = await import(
    pathToFileURL(join(syncPkg, "index.js"))
  );
  const h = syncHost();
  h.attach((await WebAssembly.instantiate(syncModule, h.imports)).exports);
  const c = await h.api.counter(13);
  assert.equal(await c.read(), 13);
  c[Symbol.dispose]();
  h.dispose();
  writeFileSync(
    join(docsProject, "sync.mts"),
    `import{createHost}from'./pkg-sync/index.js';const h=createHost();const n:number=await(await h.api.counter(13)).read();`,
  );
  run(process.execPath, [
    resolve("node_modules/typescript/bin/tsc"),
    "--strict",
    "--noEmit",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    join(docsProject, "sync.mts"),
  ]);
  console.log(
    "Sync-only Rust resources: no Rust task exports, optional bindings, constructor/method/disposal and strict TS passed",
  );
} catch (e) {
  writeFileSync(
    resolve(".cache/guest-resources-error.log"),
    `${e.stack}\n${e.stdout || ""}\n${e.stderr || ""}`,
  );
  throw Error(
    "Guest resource check failed; see .cache/guest-resources-error.log",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
