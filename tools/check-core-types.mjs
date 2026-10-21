import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rustEnvironment } from "./rust-toolchain.mjs";
import { rolldown } from "rolldown";

const root = resolve(".");
const cli =
  process.env.TARABA_LIBRARY_CLI || join(root, "target/release/taraba");
const env = {
  ...rustEnvironment(root),
  TARABA_BINDGEN: cli,
  TARABA_BINARYEN: join(root, ".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: join(
    root,
    process.env.TARABA_LIBRARY_CLI
      ? resolve(cli) === join(root, "target/release/taraba")
        ? ".cache/core-types-library-target"
        : ".cache/core-types-packaged-target"
      : ".cache/core-types-consumer-target",
  ),
};
const measurements = [];
const temp = mkdtempSync(join(tmpdir(), "taraba-core-types-"));
const run = (bin, args, cwd = temp) =>
  execFileSync(bin, args, {
    cwd,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
const wideFields = Array.from({ length: 20 }, (_, i) => `field-${i}`);
const definitions = `
record message { text: string, ids: list<u64>, enabled: bool }
variant answer { accepted(message), rejected(string), pending }
enum status { ready, busy }
flags permissions { read, write, execute }
type response = result<option<answer>, string>;
type pair = tuple<s32, string>;
type empty = tuple<>;
type nothing = result;
type only-ok = result<string>;
type only-err = result<_, string>;
type user-id = u32;
type nickname = option<string>;
record user { id:user-id, name:string, nickname:nickname }
type nested = option<option<bool>>;
type nullable-number = option<f64>;
record unused { hidden: list<char> }
record wide-record { ${wideFields.map((n) => `${n}:bool`).join(",")} }
flags wide-flags { ${wideFields.join(",")} }
type wide-tuple = tuple<${wideFields.map(() => "bool").join(",")}>;
`;
const fixtures = [
  ["bool", "bool", "bool", [false, true]],
  ["byte", "u8", "u8", [0, 255]],
  ["signed-byte", "s8", "i8", [-128, 127]],
  ["short", "u16", "u16", [0, 65535]],
  ["signed-short", "s16", "i16", [-32768, 32767]],
  ["uint", "u32", "u32", [0, 0xffffffff]],
  ["int", "s32", "i32", [-2147483648, 2147483647]],
  ["wide", "u64", "u64", [0n, 0xffffffffffffffffn]],
  ["signed-wide", "s64", "i64", [-0x8000000000000000n, 0x7fffffffffffffffn]],
  ["float", "f32", "f32", [0, -0, NaN, Infinity, -Infinity, 1.25, 1.1]],
  ["double", "f64", "f64", [0, -0, NaN, Infinity, -Infinity, 1.25]],
  [
    "text",
    "string",
    "__taraba_types::alloc::string::String",
    ["", "蟹🦀\0é", "\uFEFFhead", "a".repeat(200000)],
  ],
  ["character", "char", "char", ["\0", "蟹", "🦀"]],
  [
    "bytes",
    "list<u8>",
    "__taraba_types::alloc::vec::Vec<u8>",
    [[], [0, 128, 255]],
  ],
  [
    "message",
    "message",
    "Message",
    [{ text: "蟹🦀", ids: [1n, 0xffffffffffffffffn], enabled: true }],
  ],
  [
    "answer",
    "answer",
    "Answer",
    [
      { tag: "accepted", val: { text: "ok", ids: [], enabled: false } },
      { tag: "rejected", val: "no" },
      { tag: "pending" },
    ],
  ],
  [
    "response",
    "response",
    "Response",
    [
      { tag: "ok", val: undefined },
      { tag: "ok", val: { tag: "pending" } },
      { tag: "err", val: "bad" },
    ],
  ],
  ["pair", "pair", "Pair", [[42, "hello"]]],
  ["empty", "empty", "Empty", [[]]],
  ["nothing", "nothing", "Nothing", [{ tag: "ok" }, { tag: "err" }]],
  ["only-ok", "only-ok", "OnlyOk", [{ tag: "ok", val: "yes" }, { tag: "err" }]],
  [
    "only-err",
    "only-err",
    "OnlyErr",
    [{ tag: "ok" }, { tag: "err", val: "no" }],
  ],
  ["status", "status", "Status", ["ready", "busy"]],
  [
    "permissions",
    "permissions",
    "Permissions",
    [{ read: true, write: false, execute: true }],
  ],
];
fixtures.push(
  ["user-id", "user-id", "UserId", [0, 0xffffffff]],
  [
    "user",
    "user",
    "User",
    [
      { id: 1, name: "a" },
      { id: 2, name: "b", nickname: undefined },
      { id: 3, name: "c", nickname: "蟹" },
    ],
  ],
  [
    "nested",
    "nested",
    "Nested",
    [
      { tag: "none" },
      { tag: "some", val: undefined },
      { tag: "some", val: false },
      { tag: "some", val: true },
    ],
  ],
  [
    "nullable-number",
    "nullable-number",
    "NullableNumber",
    [undefined, 0, NaN, -0],
  ],
);
for (const [name, ty, rust, array, values] of [
  ["u8s", "u8", "u8", Uint8Array, [0, 255]],
  ["s8s", "s8", "i8", Int8Array, [-128, 127]],
  ["u16s", "u16", "u16", Uint16Array, [0, 65535]],
  ["s16s", "s16", "i16", Int16Array, [-32768, 32767]],
  ["u32s", "u32", "u32", Uint32Array, [0, 0xffffffff]],
  ["s32s", "s32", "i32", Int32Array, [-2147483648, 2147483647]],
  ["u64s", "u64", "u64", BigUint64Array, [0n, 0xffffffffffffffffn]],
  [
    "s64s",
    "s64",
    "i64",
    BigInt64Array,
    [-0x8000000000000000n, 0x7fffffffffffffffn],
  ],
  ["f32s", "f32", "f32", Float32Array, [0, -0, NaN, Infinity, 1.25]],
  ["f64s", "f64", "f64", Float64Array, [0, -0, NaN, Infinity, 1.25]],
])
  fixtures.push([
    name,
    `list<${ty}>`,
    `__taraba_types::alloc::vec::Vec<${rust}>`,
    [[], values, new array(values)],
  ]);
fixtures.push(
  [
    "wide-record",
    "wide-record",
    "WideRecord",
    [Object.fromEntries(wideFields.map((n, i) => [n, i % 2 === 0]))],
  ],
  [
    "wide-flags",
    "wide-flags",
    "WideFlags",
    [Object.fromEntries(wideFields.map((n, i) => [n, i % 2 === 0]))],
  ],
  [
    "wide-tuple",
    "wide-tuple",
    "WideTuple",
    [wideFields.map((_, i) => i % 2 === 0)],
  ],
);
const normalize = (v) => {
  if (ArrayBuffer.isView(v)) return Array.from(v, normalize);
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, normalize(v)]),
    );
  return v;
};
const scaffold = (project, std = false) => {
  run(cli, ["new", project, "--future", ...(std ? [] : ["--no-std"])]);
  const manifest = join(project, "Cargo.toml");
  const runtime =
    process.env.TARABA_LIBRARY_RUNTIME || resolve("crates/taraba");
  const allocator =
    process.env.TARABA_LIBRARY_ALLOCATOR || resolve("crates/taraba-allocator");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8") +
      "\n[patch.crates-io]\ntaraba={path=" +
      JSON.stringify(runtime) +
      "}\ntaraba-allocator={path=" +
      JSON.stringify(allocator) +
      "}\n",
  );
};
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
try {
  for (const std of [false, true]) {
    const project = join(temp, std ? "std" : "no-std");
    scaffold(project, std);
    const lib = join(project, "src/lib.rs");
    const prefix = readFileSync(lib, "utf8").split("include!(")[0];
    const wit = `package test:types; world app {${definitions}
      ${fixtures.map(([name, ty]) => `import mirror-${name}: func(v:${ty})->future<${ty}>; export %${name}: async func(v:${ty})->${ty};`).join("\n")}
      import sync-mirror:func(v:message)->message;
      export sync-message:func(v:message)->message;
    }`;
    writeFileSync(join(project, "wit/app.wit"), wit);
    writeFileSync(
      lib,
      prefix +
        `include!(concat!(env!("OUT_DIR"),"/bindings.rs")); bindings!(); struct App; impl Guest for App {` +
        fixtures
          .map(
            ([name, , rust]) =>
              `async fn r#${name.replaceAll("-", "_")}(v:${rust})->HostResult<${rust}>{mirror_${name.replaceAll("-", "_")}(v).await}`,
          )
          .join("\n") +
        `fn sync_message(v:Message)->Message {sync_mirror(v)} } export!(App);`,
    );
    run(cli, ["build"], project);
    const pkg = join(project, "pkg");
    const source = readFileSync(join(pkg, "index.js"), "utf8");
    const types = readFileSync(join(pkg, "index.d.ts"), "utf8");
    assert.doesNotMatch(
      types,
      /Promise<unknown>|hidden|taraba-codec|TarabaType/,
    );
    assert.match(types, /export type Message =/);
    assert.match(types, /export type UserId = number/);
    const { createHost } = await import(pathToFileURL(join(pkg, "index.js")));
    const bindings = Object.fromEntries(
      fixtures.map(([name]) => [`mirror-${name}`, async (v) => v]),
    );
    bindings["sync-mirror"] = (v) => v;
    bindings["mirror-bytes"] = (v) => ({
      then(resolve) {
        queueMicrotask(() => resolve(v));
      },
    });
    const host = createHost({ bindings });
    const bytes = readFileSync(join(pkg, "app.wasm"));
    const wasmExports = (await WebAssembly.instantiate(bytes, host.imports))
      .instance.exports;
    host.attach(wasmExports);
    for (const [name, , , [...values]] of fixtures)
      for (const value of values) {
        assert.deepEqual(
          normalize(await host[name](value)),
          normalize(name === "float" ? Math.fround(value) : value),
          `${std}/${name}`,
        );
        assert.equal(host.stats().live_values, 0, `${name}: leaked value`);
      }
    assert.deepEqual(
      normalize(
        await host["sync-message"](
          fixtures.find(([n]) => n === "message")[3][0],
        ),
      ),
      normalize(fixtures.find(([n]) => n === "message")[3][0]),
    );
    for (const value of [
      "\ud800",
      "\udc00",
      "a\ud800b",
      "\ud800\ud800",
      "\udc00\ud800",
      "\ud800\udc00",
    ]) {
      assert.equal(await host.text(value), value.toWellFormed());
      assert.equal(host.stats().live_values, 0);
    }
    assert.doesNotMatch(source, /taraba-codec/);
    assert.equal(await host["nullable-number"](), undefined);
    const input = new Uint8Array([99, 1, 2, 88]).subarray(1, 3);
    const output = await host.bytes(input);
    assert.ok(output instanceof Uint8Array);
    input.fill(9);
    assert.deepEqual([...output], [1, 2]);
    wasmExports.memory.grow(1);
    assert.deepEqual([...output], [1, 2]);
    assert.equal(host.stats().live_values, 0);
    const error = { code: "external", message: "same identity" };
    bindings["mirror-message"] = async () => {
      throw error;
    };
    // The host captures functions at creation time; make independent instances for failure paths.
    const module = await WebAssembly.compile(bytes);
    const rejected = createHost({ bindings });
    rejected.attach(
      (await WebAssembly.instantiate(module, rejected.imports)).exports,
    );
    await assert.rejects(
      rejected.message(fixtures.find(([n]) => n === "message")[3][0]),
      (e) => e === error,
    );
    await flush();
    assert.equal(rejected.stats().live_values, 0);
    assert.equal(rejected.stats().dead, false);
    assert.equal(await rejected.bool(true), true);
    let release;
    bindings["mirror-message"] = () =>
      new Promise((r) => {
        release = r;
      });
    const cancelled = createHost({ bindings });
    cancelled.attach(
      (await WebAssembly.instantiate(module, cancelled.imports)).exports,
    );
    const value = fixtures.find(([n]) => n === "message")[3][0];
    const pending = cancelled.message(value);
    const failure = assert.rejects(pending, (e) => e.name === "AbortError");
    await flush();
    cancelled.cancel(cancelled.activeTasks()[0]);
    await failure;
    release(value);
    await flush();
    assert.equal(cancelled.stats().live_values, 0);
    assert.equal(cancelled.stats().live_waits, 0);
    assert.equal(cancelled.stats().live_tasks, 0);
    assert.equal(await cancelled.bool(true), true);
    // Validate generated public contract with the actual TypeScript compiler.
    writeFileSync(
      join(project, "typecheck.mts"),
      `import {createHost} from './pkg/index.js';
import type {AppBindings,Message,Response,Answer,User,UserId,Nickname,Nested,WitInput} from './pkg/index.js';
const bindings = {
${fixtures.map(([name]) => `"mirror-${name}": v=>Promise.resolve(v),`).join("\n")}
"sync-mirror": v=>v,
} satisfies AppBindings;
const host = createHost({bindings});
const result: Promise<bigint> = host.wide(1n);
const message: WitInput<Message> = {text:'ok',ids:[1n],enabled:true} as const;
const record: Promise<Message> = host.message(message);
const bytes: Promise<Uint8Array> = host.bytes(new Uint8Array([1,2]));
const readonlyBytes = [1,2] as const;
host.bytes(readonlyBytes);
const user: User={id:1,name:'a'};
const explicit: WitInput<User>={...user,nickname:undefined};
host.user(explicit);
const id: UserId=42;
const nickname:Nickname=undefined;
const optional:Promise<number|undefined>=host["nullable-number"]();
const nested:Nested={tag:'some',val:undefined}; host.nested(nested);
function consume(response:Response) {
  if(response.tag==='err') {const reason:string=response.val; return reason;}
  if(response.val!==undefined) {const answer:Answer=response.val; return answer.tag;}
  return 'none';
}
// @ts-expect-error wrong payload
host.wide('no');
// @ts-expect-error wrong record field
host.message({text:'ok',ids:[1],enabled:true});
// @ts-expect-error nested option must preserve the outer tag
host.nested(false);
// @ts-expect-error u8 list takes numbers, not bigint
host.bytes([1n]);
`,
    );
    run(
      join(root, "node_modules/.bin/tsc"),
      [
        "--strict",
        "--exactOptionalPropertyTypes",
        "--noUncheckedIndexedAccess",
        "--verbatimModuleSyntax",
        "--noEmit",
        "--target",
        "es2022",
        "--module",
        "nodenext",
        "typecheck.mts",
      ],
      project,
    );
    measurements.push({
      std,
      types: fixtures.length,
      wasm_bytes: bytes.length,
      glue_bytes: Buffer.byteLength(source),
    });
    console.log(
      `Core types ${std ? "std" : "no_std"}: ${fixtures.length} types, round trips, error identity, cancellation, strict TS passed (${bytes.length} B Wasm, ${Buffer.byteLength(source)} B glue)`,
    );
  }
  // Execute the WIT/Rust/TS documentation as an external consumer.
  const block = (text, language) => {
    const match = text.match(
      new RegExp("```" + language + "\\n([\\s\\S]*?)\\n```"),
    );
    assert.ok(match);
    return match[1];
  };
  const pages = ["docs/typescript.md", "docs/typescript.ja.md"].map((p) =>
    readFileSync(p, "utf8"),
  );
  const snippets = Object.fromEntries(
    ["wit", "rust", "ts"].map((language) => {
      const source = block(pages[0], language);
      assert.equal(source, block(pages[1], language));
      return [language, source];
    }),
  );
  for (const std of [false, true]) {
    const project = join(temp, std ? "ts-doc-std" : "ts-doc-no-std");
    scaffold(project, std);
    const lib = join(project, "src/lib.rs"),
      prefix = readFileSync(lib, "utf8").split("include!(")[0];
    writeFileSync(lib, prefix + snippets.rust + "\n");
    writeFileSync(join(project, "wit/app.wit"), snippets.wit);
    run(cli, ["build"], project);
    writeFileSync(join(project, "client.mts"), snippets.ts);
    run(
      join(root, "node_modules/.bin/tsc"),
      [
        "--strict",
        "--exactOptionalPropertyTypes",
        "--noUncheckedIndexedAccess",
        "--verbatimModuleSyntax",
        "--target",
        "es2022",
        "--module",
        "nodenext",
        "client.mts",
      ],
      project,
    );
    const { example } = await import(
      pathToFileURL(join(project, "client.mjs"))
    );
    assert.deepEqual(
      await example(
        Uint8Array.from(readFileSync(join(project, "pkg/app.wasm"))).buffer,
      ),
      { tag: "ok", val: { accepted: 3 } },
    );
    if (!std) {
      const packs = join(temp, "ts-packs"),
        consumer = join(temp, "ts-consumer");
      mkdirSync(packs);
      mkdirSync(consumer);
      const pkg = join(project, "pkg"),
        name = JSON.parse(readFileSync(join(pkg, "package.json"))).name;
      run("pnpm", ["pack", "--pack-destination", packs], pkg);
      const tarball = join(
        packs,
        readdirSync(packs).find((f) => f.endsWith(".tgz")),
      );
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ private: true, type: "module" }),
      );
      run("pnpm", ["add", "--offline", tarball], consumer);
      writeFileSync(
        join(consumer, "client.mts"),
        snippets.ts.replaceAll("'./pkg/index.js'", JSON.stringify(name)),
      );
      const strict = [
        "--strict",
        "--exactOptionalPropertyTypes",
        "--noUncheckedIndexedAccess",
        "--verbatimModuleSyntax",
        "--target",
        "es2022",
      ];
      run(
        join(root, "node_modules/.bin/tsc"),
        [...strict, "--module", "nodenext", "client.mts"],
        consumer,
      );
      run(
        join(root, "node_modules/.bin/tsc"),
        [
          ...strict,
          "--module",
          "esnext",
          "--moduleResolution",
          "bundler",
          "--noEmit",
          "client.mts",
        ],
        consumer,
      );
      const installed = await import(
        pathToFileURL(join(consumer, "client.mjs"))
      );
      assert.deepEqual(
        await installed.example(
          Uint8Array.from(readFileSync(join(pkg, "app.wasm"))).buffer,
        ),
        { tag: "ok", val: { accepted: 3 } },
      );
      writeFileSync(
        join(consumer, "entry.mjs"),
        `export * from ${JSON.stringify(name)};`,
      );
      assert.deepEqual(
        Object.keys(await import(pathToFileURL(join(consumer, "entry.mjs")))),
        ["createHost"],
      );
    }
  }
  console.log(
    "TS documentation: EN/JA WIT/Rust/TS examples std/no_std; npm pack/install + NodeNext/bundler typing and execution passed",
  );
  // Measure individual codec families with the same one-await echo algorithm.
  const samples = [];
  const sampleTypes = [
    ["s32", "i32", 42],
    ["bool", "bool", true],
    ["u64", "u64", 0xffffffffffffffffn],
    ["string", "__taraba_types::alloc::string::String", "蟹🦀"],
    ["list<u8>", "__taraba_types::alloc::vec::Vec<u8>", [0, 128, 255]],
  ];
  for (const [ty, rust, value] of sampleTypes) {
    const project = join(temp, `sample-${samples.length}`);
    scaffold(project);
    const lib = join(project, "src/lib.rs");
    const prefix = readFileSync(lib, "utf8").split("include!(")[0];
    writeFileSync(
      join(project, "wit/app.wit"),
      `package test:sample; world app { import echo:async func(v:${ty})->${ty}; export run:async func(v:${ty})->${ty}; }`,
    );
    writeFileSync(
      lib,
      prefix +
        `include!(concat!(env!("OUT_DIR"),"/bindings.rs")); bindings!(); struct App; impl Guest for App {async fn run(v:${rust})->HostResult<${rust}> { echo(v).await }} export!(App);`,
    );
    run(cli, ["build"], project);
    const pkg = join(project, "pkg");
    const { createHost } = await import(pathToFileURL(join(pkg, "index.js")));
    const host = createHost({ bindings: { echo: async (v) => v } });
    const wasm = readFileSync(join(pkg, "app.wasm"));
    host.attach(
      (await WebAssembly.instantiate(wasm, host.imports)).instance.exports,
    );
    assert.deepEqual(normalize(await host.run(value)), normalize(value));
    assert.equal(host.stats().live_values, 0);
    const source = readFileSync(join(pkg, "index.js"), "utf8");
    if (ty !== "string") assert.doesNotMatch(source, /TextEncoder|TextDecoder/);
    if (ty !== "string" && !ty.startsWith("list<"))
      assert.doesNotMatch(source, /memory\.buffer/);
    if (ty !== "u64") assert.doesNotMatch(source, /BigInt/);
    assert.doesNotMatch(source, /fromCodePoint/);
    const bundle = await rolldown({
      input: join(pkg, "index.js"),
      platform: "neutral",
      transform: { target: "es2022" },
    });
    let output;
    try {
      output = await bundle.generate({ format: "esm", minify: true });
    } finally {
      await bundle.close();
    }
    const runtime = readFileSync(join(pkg, "runtime.mjs"));
    assert.deepEqual(
      runtime,
      readFileSync(join(root, "crates/taraba-cli/assets/taraba.mjs")),
    );
    samples.push({
      type: ty,
      wasm_bytes: wasm.length,
      js_bytes: Buffer.byteLength(output.output[0].code),
      shared_runtime_bytes: runtime.length,
    });
  }
  // Pure synchronous rich values select Future glue without installing an executor.
  const sync = join(temp, "sync");
  scaffold(sync);
  const syncLib = join(sync, "src/lib.rs"),
    syncPrefix = readFileSync(syncLib, "utf8").split("include!(")[0];
  const stringType = "__taraba_types::alloc::string::String";
  writeFileSync(
    join(sync, "wit/app.wit"),
    "package test:sync; world app {export text:func()->string; export size:func(v:string)->u32;}",
  );
  writeFileSync(
    syncLib,
    syncPrefix +
      `include!(concat!(env!("OUT_DIR"),"/bindings.rs")); bindings!(); struct App; impl Guest for App {fn text()->${stringType} {"蟹🦀".into()} fn size(v:${stringType})->u32 {v.len() as u32}} export!(App);`,
  );
  run(cli, ["build"], sync);
  const syncPkg = join(sync, "pkg"),
    { createHost: syncHost } = await import(
      pathToFileURL(join(syncPkg, "index.js"))
    );
  const synchronous = syncHost();
  const syncModule = await WebAssembly.compile(
    readFileSync(join(syncPkg, "app.wasm")),
  );
  assert.ok(
    WebAssembly.Module.exports(syncModule).every(
      (e) => !e.name.startsWith("rt_"),
    ),
  );
  synchronous.attach(
    (await WebAssembly.instantiate(syncModule, synchronous.imports)).exports,
  );
  assert.equal(await synchronous.text(), "蟹🦀");
  assert.equal(await synchronous.size("蟹🦀"), 7);
  assert.equal(synchronous.stats().live_values, 0);
  writeFileSync(
    join(sync, "typecheck.mts"),
    `import {createHost} from './pkg/index.js'; const host=createHost(); const value:Promise<string>=host.text();`,
  );
  run(
    join(root, "node_modules/.bin/tsc"),
    [
      "--strict",
      "--noEmit",
      "--target",
      "es2022",
      "--module",
      "nodenext",
      "typecheck.mts",
    ],
    sync,
  );
  // Build an encode-only string API: the decoder is required, the encoder is absent.
  writeFileSync(
    join(sync, "wit/app.wit"),
    "package test:sync; world app {export text:func()->string;}",
  );
  writeFileSync(
    syncLib,
    syncPrefix +
      `include!(concat!(env!("OUT_DIR"),"/bindings.rs")); bindings!(); struct App; impl Guest for App {fn text()->${stringType} {"蟹🦀".into()}} export!(App);`,
  );
  run(cli, ["build"], sync);
  const directional = readFileSync(join(syncPkg, "index.js"), "utf8");
  assert.match(directional, /TextDecoder/);
  assert.doesNotMatch(directional, /TextEncoder|encodeInto/);
  const aliasProject = join(temp, "scalar-alias");
  scaffold(aliasProject);
  const aliasLib = join(aliasProject, "src/lib.rs"),
    aliasPrefix = readFileSync(aliasLib, "utf8").split("include!(")[0];
  writeFileSync(
    aliasLib,
    aliasPrefix +
      `include!(concat!(env!("OUT_DIR"),"/bindings.rs")); bindings!(); struct App; impl Guest for App {fn identity(v:u32)->u32 {v}} export!(App);`,
  );
  const aliases = [];
  for (const named of [false, true]) {
    writeFileSync(
      join(aliasProject, "wit/app.wit"),
      `package test:ids; world app {${named ? "type user-id=u32;" : ""} export identity:func(v:${named ? "user-id" : "u32"})->${named ? "user-id" : "u32"};}`,
    );
    run(cli, ["build"], aliasProject);
    const pkg = join(aliasProject, "pkg");
    aliases.push({
      wasm: readFileSync(join(pkg, "app.wasm")),
      js: readFileSync(join(pkg, "index.js")),
      runtime: readFileSync(join(pkg, "runtime.mjs")),
    });
    if (named)
      assert.match(
        readFileSync(join(pkg, "index.d.ts"), "utf8"),
        /export type UserId = number/,
      );
  }
  assert.deepEqual(
    aliases[1],
    aliases[0],
    "type-only numeric alias must not select another runtime or add deployed bytes",
  );
  // Unused declarations AND an unused import of a rich type add no deployed bytes.
  const project = join(temp, "dead-code");
  scaffold(project);
  const snapshots = [];
  for (const extra of [
    "",
    "record ignored {text:string, ids:list<u64>} import unused: async func(v:ignored)->ignored;",
    "resource",
  ]) {
    writeFileSync(
      join(project, "wit/app.wit"),
      `package taraba:app@0.1.0; ${extra === "resource" ? "interface ignored {resource value; make:async func()->own<value>;}" : ""} world app {${extra === "resource" ? "import unused:ignored;" : extra} import add:func(a:s32,b:s32)->future<s32>; export run:func(a:s32,b:s32)->future<s32>;}`,
    );
    run(cli, ["build"], project);
    const pkg = join(project, "pkg");
    const bundle = await rolldown({
      input: join(pkg, "index.js"),
      platform: "neutral",
      transform: { target: "es2022" },
    });
    let output;
    try {
      output = await bundle.generate({ format: "esm", minify: true });
    } finally {
      await bundle.close();
    }
    snapshots.push({
      wasm: readFileSync(join(pkg, "app.wasm")),
      js: output.output[0].code,
      runtime: readFileSync(join(pkg, "runtime.mjs")),
    });
    assert.doesNotMatch(
      readFileSync(join(pkg, "index.js"), "utf8"),
      /TextEncoder|TextDecoder|BigInt|taraba-codec/,
    );
  }
  assert.deepEqual(
    snapshots[1],
    snapshots[0],
    "unused rich types/import must add zero Wasm/JS bytes",
  );
  assert.deepEqual(
    snapshots[2],
    snapshots[0],
    "unused resources/interfaces must add zero Wasm/JS bytes",
  );
  console.log(
    `Unused rich types: +0 B Wasm / +0 B JS; shared runtime unchanged`,
  );
  const report = {
    all_passed: true,
    conditions: {
      sample_algorithm: "one async host echo, one await, same value returned",
      rust: "cargo release, scaffold defaults",
      wasm_opt: "Binaryen 133 -Oz",
      js: "Rolldown minify, ESM",
      compression: "none",
      sample_std: false,
      js_includes_shared_runtime: true,
    },
    measurements,
    samples,
    unused_wasm_growth: 0,
    unused_js_growth: 0,
  };
  writeFileSync(
    join(root, ".cache/core-types-check.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (process.argv.includes("--snapshot")) {
    writeFileSync(
      join(root, "docs/core-types-size.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    for (const language of ["en", "ja"]) {
      const page = join(
        root,
        language === "ja" ? "docs/core-runtime.ja.md" : "docs/core-runtime.md",
      );
      const header =
        language === "ja"
          ? "| WIT の値型 | Wasm | JS（共有分込み） | s32 比 Wasm 増分 | s32 比 JS 増分 |"
          : "| WIT value type | Wasm | JS (including shared runtime) | Wasm growth vs s32 | JS growth vs s32 |";
      const rows = samples.map(
        (s) =>
          `| \`${s.type}\` | ${s.wasm_bytes} B | ${s.js_bytes} B | +${s.wasm_bytes - samples[0].wasm_bytes} B | +${s.js_bytes - samples[0].js_bytes} B |`,
      );
      const table = [
        header,
        "| --- | ---: | ---: | ---: | ---: |",
        ...rows,
      ].join("\n");
      const marker =
        "<!-- core-types-size:begin -->\n" +
        table +
        "\n<!-- core-types-size:end -->";
      writeFileSync(
        page,
        readFileSync(page, "utf8").replace(
          /<!-- core-types-size:begin -->[\s\S]*?<!-- core-types-size:end -->/,
          marker,
        ),
      );
    }
  }
  rmSync(join(root, ".cache/core-types-error.log"), { force: true });
  console.table(samples);
} catch (e) {
  writeFileSync(
    join(root, ".cache/core-types-error.log"),
    `${e.stack}\n${e.stdout || ""}\n${e.stderr || ""}`,
  );
  throw Error(
    `Core types check failed; see .cache/core-types-error.log (fixture ${temp})`,
  );
} finally {
  if (!process.env.TARABA_KEEP_FIXTURE)
    rmSync(temp, { recursive: true, force: true });
}
