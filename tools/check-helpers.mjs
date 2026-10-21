import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { rustEnvironment } from "./rust-toolchain.mjs";
import { verifyWit } from "../tests/support/wit-contract.mjs";
import { verifyScheduling } from "../tests/support/scheduling.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";
import { regexTable, auditTable } from "./helpers-report.mjs";
import { observeHelperRoots } from "../tests/support/helper-roots.mjs";

const root = resolve(".");
const cli = process.env.TARABA_LIBRARY_CLI || resolve("target/release/taraba");
const helpers =
  process.env.TARABA_LIBRARY_HELPERS || resolve("crates/taraba-helpers");
const allocator =
  process.env.TARABA_LIBRARY_ALLOCATOR || resolve("crates/taraba-allocator");
const runtime = process.env.TARABA_LIBRARY_RUNTIME || resolve("crates/taraba");
const base = resolve(".cache/helpers");
const env = {
  ...rustEnvironment(root),
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: resolve(".cache/helpers-target"),
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
    throw new Error(`${bin} ${args.join(" ")}\n${e.stderr || e.stdout}`, {
      cause: e,
    });
  }
}

// Shared subset only. Neither this corpus nor the size result claims full
// compatibility between the ECMAScript and Rust regex languages.
const patterns = [
  "^[a-z]+$",
  "^[0-9]{1,4}$",
  "(?:foo|bar)+",
  "蟹+",
  "🦀",
  "^.$",
  "^$",
  "[",
];
const texts = [
  "",
  "a",
  "abc",
  "ab1",
  "1",
  "1234",
  "12345",
  "foo",
  "foobar",
  "蟹蟹",
  "🦀",
  "蟹🦀",
  "日本語",
  " ",
];
const rustStrings = (a) => a.map((s) => JSON.stringify(s)).join(",");
const regexBody = (kind) => `
use ${kind === "helper" ? "taraba_helpers::regexp::RegExp" : "regex::Regex"} as Regex;
#[unsafe(no_mangle)]
pub extern "C" fn run(p: i32, t: i32, repetitions: i32) -> i32 {
    let patterns = [${rustStrings(patterns)}];
    let texts = [${rustStrings(texts)}];
    let Ok(re) = Regex::new(patterns[p as u32 as usize % patterns.len()]) else { return -1; };
    let text = texts[t as u32 as usize % texts.len()];
    let mut found = 0;
    for _ in 0..repetitions.clamp(0, 128) { found += i32::from(re.is_match(text)); }
    found
}
`;
const candidates = [
  { name: "baseline-no_std", std: false, body: "n" },
  { name: "baseline-std", std: true, body: "n" },
  {
    name: "format-integer",
    std: true,
    body: 'format!("{n}").len() as i32',
    check: (n) => String(n).length,
  },
  {
    name: "format-integer-no_std",
    std: false,
    body: 'alloc::format!("{n}").len() as i32',
    check: (n) => String(n).length,
  },
  {
    name: "format-float",
    std: true,
    body: 'format!("{:.3}", n as f64 / 8.0).len() as i32',
    check: (n) => (n / 8).toFixed(3).length,
  },
  {
    name: "format-float-no_std",
    std: false,
    body: 'alloc::format!("{:.3}", n as f64 / 8.0).len() as i32',
    check: (n) => (n / 8).toFixed(3).length,
  },
  {
    name: "hash-map",
    std: true,
    body: "let mut map = std::collections::HashMap::new(); map.insert(n, n.wrapping_add(1)); *map.get(&n).unwrap()",
    check: (n) => (n + 1) | 0,
  },
  {
    name: "btree-map",
    std: true,
    body: "let mut map = std::collections::BTreeMap::new(); map.insert(n, n.wrapping_add(1)); *map.get(&n).unwrap()",
    check: (n) => (n + 1) | 0,
  },
  {
    name: "btree-map-no_std",
    std: false,
    body: "let mut map = alloc::collections::BTreeMap::new(); map.insert(n, n.wrapping_add(1)); *map.get(&n).unwrap()",
    check: (n) => (n + 1) | 0,
  },
  {
    name: "serde-json",
    std: true,
    dependencies: 'serde_json = "=1.0.150"',
    body: 'let s = if n & 1 == 0 { r#"{"value":42,"label":"蟹"}"# } else { r#"{"value":7,"label":"🦀"}"# }; let v: serde_json::Value = serde_json::from_str(s).unwrap(); v["value"].as_i64().unwrap() as i32',
    check: (n) => (n & 1 ? 7 : 42),
  },
  {
    name: "url",
    std: true,
    dependencies: 'url = "=2.5.8"',
    body: 'let s = if n & 1 == 0 { "https://example.com/a?q=1" } else { "https://例え.jp/" }; url::Url::parse(s).unwrap().host_str().unwrap().len() as i32',
    check: (n) =>
      new URL(n & 1 ? "https://例え.jp/" : "https://example.com/a?q=1").hostname
        .length,
  },
  {
    name: "chrono-format",
    std: true,
    dependencies:
      'chrono = {version="=0.4.45", default-features=false, features=["std"]}',
    body: 'chrono::DateTime::from_timestamp(n as i64, 0).unwrap().format("%Y-%m-%d").to_string().len() as i32',
    check: () => 10,
  },
  { name: "helper-regexp-no_std", std: false, regex: "helper" },
  { name: "helper-regexp-std", std: true, regex: "helper" },
  {
    name: "rust-regex-default",
    std: true,
    regex: "rust",
    dependencies: 'regex = "=1.13.1"',
  },
  {
    name: "rust-regex-minimal",
    std: true,
    regex: "rust",
    dependencies:
      'regex = {version="=1.13.1", default-features=false, features=["std"]}',
  },
];
const report = {
  schema: 1,
  node: process.version,
  safari_browser_verified: false,
  algorithm:
    "Compile a selected shared-subset pattern once, run is_match repeatedly, drop; identical Rust control flow",
  regex_cases: patterns.length * texts.length * 4,
  audit_scope:
    "Independent feature probes, not equivalent algorithms across different features",
  rows: [],
  async: [],
};
const snapshot = existsSync("docs/helpers-size.json")
  ? JSON.parse(readFileSync("docs/helpers-size.json"))
  : {};
for (const c of candidates.filter(
  (c) => !process.env.TARABA_HELPERS_SMOKE || c.regex === "helper",
)) {
  const project = join(base, c.name);
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "wit"), { recursive: true });
  writeFileSync(
    join(project, "Cargo.toml"),
    `[package]\nname="helpers-${c.name.replaceAll("_", "-")}"\nversion="0.1.0"\nedition="2024"\n[workspace]\n[lib]\ncrate-type=["cdylib"]\n[dependencies]\ntaraba-helpers={path=${JSON.stringify(helpers)},features=["regexp"]}\ntaraba-allocator={path=${JSON.stringify(allocator)}}\n${c.dependencies || ""}\n[profile.release]\nopt-level="z"\nlto=true\ncodegen-units=1\npanic="abort"\nstrip=false\n`,
  );
  const prelude = c.std
    ? ""
    : "#![no_std]\n#[panic_handler]\nfn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }\n";
  const source = `${prelude}\nextern crate alloc;\n#[global_allocator]\nstatic ALLOC: taraba_allocator::WeeAlloc = taraba_allocator::WeeAlloc::INIT;\n${c.regex ? regexBody(c.regex) : `#[unsafe(no_mangle)]\npub extern "C" fn run(n:i32)->i32 { ${c.body} }\n`}`;
  writeFileSync(join(project, "src/lib.rs"), source);
  const lock = snapshot.rows?.find((r) => r.name === c.name)?.cargo_lock;
  if (lock) writeFileSync(join(project, "Cargo.lock"), lock);
  writeFileSync(
    join(project, "wit/app.wit"),
    `package test:helpers; world app { export run: func(${c.regex ? "p: s32, t: s32, repetitions: s32" : "n: s32"}) -> s32; }\n`,
  );
  const output = join(project, "pkg");
  const log = run(
    cli,
    [
      "build",
      "--out-dir",
      output,
      "--insight",
      "--npm-name",
      `@taraba-test/${c.name.replaceAll("_", "-")}`,
    ],
    project,
  );
  const wasm = readFileSync(join(output, "app.wasm"));
  const { createHost } = await import(pathToFileURL(join(output, "index.js")));
  const host = createHost();
  const { instance } = await WebAssembly.instantiate(wasm, host.imports);
  host.attach(instance.exports);
  let checks = 0;
  if (c.regex) {
    for (let p = 0; p < patterns.length; p++) {
      let regex;
      try {
        regex = new RegExp(patterns[p], "u");
      } catch {
        /* intentional invalid pattern */
      }
      for (let t = 0; t < texts.length; t++)
        for (const reps of [0, 1, 2, 17]) {
          const expected = regex ? +regex.test(texts[t]) * reps : -1;
          assert.equal(
            await host.run(p, t, reps),
            expected,
            `${c.name}: ${p}/${t}/${reps}`,
          );
          checks++;
        }
    }
  } else {
    for (const n of [-2147483648, -100, -1, 0, 1, 8, 99, 2147483647]) {
      assert.equal(await host.run(n), (c.check || ((n) => n))(n), c.name);
      checks++;
    }
  }
  assert.equal(host.stats().dead, false);
  const jsBytes = readdirSync(output)
    .filter((f) => /\.m?js$/.test(f))
    .reduce((n, f) => n + readFileSync(join(output, f)).length, 0);
  const info = JSON.parse(readFileSync(join(output, "build.json")));
  assert.equal(info.js_bytes, jsBytes);
  assert.equal(
    existsSync(join(output, "helpers-regexp.mjs")),
    c.regex === "helper",
  );
  assert.equal(
    info.profile,
    "wit-core-jspi",
    "helpers do not require a Rust Future executor",
  );
  const analysis = JSON.parse(
    run(cli, ["insight", output, "--top", "12", "--json"]),
  );
  const rustc = run("rustc", ["--version"]).trim();
  report.rows.push({
    name: c.name,
    std: c.std,
    wasm_bytes: wasm.length,
    js_bytes: jsBytes,
    total_bytes: wasm.length + jsBytes,
    helpers_js_bytes: info.helpers_js_bytes || 0,
    tests: checks,
    rustc,
    cargo_lock: readFileSync(join(project, "Cargo.lock"), "utf8"),
    cargo_lock_sha256: createHash("sha256")
      .update(readFileSync(join(project, "Cargo.lock")))
      .digest("hex"),
    sections: analysis.sections,
    groups: analysis.groups,
    top_functions: analysis.functions,
  });
  if (c.regex === "helper") {
    const pack = join(project, "pack");
    mkdirSync(pack, { recursive: true });
    run("pnpm", ["pack", "--pack-destination", pack], output);
    const archive = join(
      pack,
      readdirSync(pack).find((f) => f.endsWith(".tgz")),
    );
    const entries = run("tar", ["-tzf", archive]);
    assert.ok(entries.includes("package/helpers-regexp.mjs"));
    assert.ok(!entries.includes(".taraba/"));
    const consumer = mkdtempSync(join(tmpdir(), "taraba-helpers-npm-"));
    try {
      writeFileSync(
        join(consumer, "package.json"),
        '{"private":true,"type":"module"}\n',
      );
      run("pnpm", ["add", "--offline", "--ignore-scripts", archive], consumer);
      const name = `@taraba-test/${c.name.replaceAll("_", "-")}`;
      writeFileSync(
        join(consumer, "consumer.mts"),
        `import {createHost} from '${name}';\nconst host = createHost();\nhost.run(0, 1, 2).then((n: number) => n);\n// @ts-expect-error scalar WIT arguments must be numbers\nhost.run('bad', 1, 2);\n`,
      );
      run(
        resolve("node_modules/.bin/tsc"),
        [
          "--strict",
          "--noEmit",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--lib",
          "ES2022,DOM",
          "consumer.mts",
        ],
        consumer,
      );
      const installed = join(consumer, "node_modules", name);
      const { createHost } = await import(
        pathToFileURL(join(installed, "index.js"))
      );
      const packedHost = createHost();
      const { instance } = await WebAssembly.instantiate(
        readFileSync(join(installed, "app.wasm")),
        packedHost.imports,
      );
      packedHost.attach(instance.exports);
      assert.equal(await packedHost.run(0, 1, 2), 2);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  }
  console.log(
    `${c.name}: ${wasm.length} B Wasm + ${jsBytes} B JS; ${checks} tests`,
  );
  assert.match(log, /B Wasm/);
}
// A RegExp stays owned across two genuine Promise suspensions in both profiles.
const batches = [1, 16, 128, 1024].flatMap((n) => asyncCases(n));
const asyncRoot = mkdtempSync(join(tmpdir(), "taraba-helpers-async-"));
try {
  for (const profile of ["jspi", "future"]) {
    const project = join(asyncRoot, profile);
    run(cli, ["new", project, "--no-std", `--${profile}`]);
    const manifest = join(project, "Cargo.toml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace(
        "[dependencies]",
        `[dependencies]\ntaraba-helpers={path=${JSON.stringify(helpers)},features=["regexp","strings","segmenter"]}`,
      ) +
        `\n[patch.crates-io]\ntaraba={path=${JSON.stringify(runtime)}}\ntaraba-allocator={path=${JSON.stringify(allocator)}}\n`,
    );
    const source = join(project, "src/lib.rs");
    const error =
      profile === "future"
        ? "return Err(::taraba::JsValue::from_i32(-10));"
        : "return -10;";
    writeFileSync(
      source,
      readFileSync(source, "utf8")
        .replace(
          "#[global_allocator]",
          "extern crate alloc;\n#[global_allocator]",
        )
        .replace(
          "let first =",
          `let re = taraba_helpers::regexp::RegExp::new("^(?:蟹|🦀)+$").unwrap();
        let text = taraba_helpers::string::JsString::from("蟹🦀");
        let mut parts = taraba_helpers::segmenter::Segmenter::new("ja", taraba_helpers::segmenter::Granularity::Grapheme).unwrap().segment(&text);
        let part = parts.next().unwrap();
        // Keep the aggregate behind one pointer within the fixed 128-byte task slot.
        // All four roots must still stay live across await and drop on cancellation.
        let mut held = alloc::boxed::Box::new((re, text, parts, part));
        let first =`,
        )
        .replace(
          profile === "future" ? "add(first, 1).await" : "add(first, 1)",
          `if !held.0.is_match_js(&held.1) || held.3.text() != taraba_helpers::string::JsString::from("蟹") || held.2.next().unwrap().text() != taraba_helpers::string::JsString::from("🦀") { ${error} }\n        ${profile === "future" ? "add(first, 1).await" : "add(first, 1)"}`,
        ),
    );
    for (const std of [false, true]) {
      const output = join(project, std ? "std" : "no_std");
      run(
        cli,
        ["build", "--out-dir", output, ...(std ? ["--features", "std"] : [])],
        project,
      );
      const { createHost } = await import(
        pathToFileURL(join(output, "index.js"))
      );
      const bytes = readFileSync(join(output, "app.wasm"));
      const observed = [];
      const live = () => observed.reduce((n, s) => n + s.total(), 0);
      const instantiate = async (add) => {
        const host = createHost({ bindings: { add } });
        observed.push(observeHelperRoots(host));
        const { instance } = await WebAssembly.instantiate(bytes, host.imports);
        host.attach(instance.exports);
        return host;
      };
      // Handle IDs are per instance; verify each contract with its own registry.
      const factory = async (add) => {
        const host = await instantiate(add);
        return host.run;
      };
      const common = await verifyWit(factory, batches);
      assert.equal(live(), 0);
      const scheduling = await verifyScheduling(factory, {
        serialized: profile === "jspi",
      });
      assert.equal(live(), 0);
      if (profile === "future") {
        const host = await instantiate(() => new Promise(() => {}));
        const pending = host.run(1, 2);
        for (let i = 0; i < 30 && live() === 0; i++) await Promise.resolve();
        assert.equal(observed.at(-1).regex(), 1);
        assert.ok(
          observed.at(-1).values() >= 3,
          "string, iterator and yielded segment stay owned across await",
        );
        host.cancel(host.activeTasks()[0]);
        await assert.rejects(pending, (e) => e.name === "AbortError");
        assert.equal(
          live(),
          0,
          "cancellation drops strings, iterator, yielded segment and RegExp held across await",
        );
      }
      report.async.push({
        profile,
        std,
        common,
        scheduling,
        live_roots_after: live(),
      });
      console.log(
        `${profile}/${std ? "std" : "no_std"}: helpers across await, common async contract and scheduling passed`,
      );
    }
  }
} finally {
  rmSync(asyncRoot, { recursive: true, force: true });
}
report.all_passed = true;
mkdirSync(base, { recursive: true });
writeFileSync(
  join(base, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
if (process.argv.includes("--snapshot")) {
  assert.ok(!process.env.TARABA_HELPERS_SMOKE);
  report.generated_at = new Date().toISOString();
  const inputs = [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "tools/check-helpers.mjs",
    "tools/helpers-report.mjs",
    "tools/build-host.mjs",
    "tools/import-contract.mjs",
    "package.json",
    "pnpm-lock.yaml",
  ];
  function files(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) files(path);
      else if (e.isFile()) inputs.push(path);
    }
  }
  for (const dir of [
    "crates/taraba-cli/src",
    "crates/taraba-cli/assets",
    "crates/taraba-helpers/src",
    "crates/taraba-helpers/wit",
    "crates/taraba-allocator/src",
    "src",
  ])
    files(dir);
  inputs.push(
    "crates/taraba-helpers/Cargo.toml",
    "crates/taraba-allocator/Cargo.toml",
  );
  report.inputs = Object.fromEntries(
    inputs
      .sort()
      .map((f) => [
        f,
        createHash("sha256").update(readFileSync(f)).digest("hex"),
      ]),
  );
  writeFileSync(
    "docs/helpers-size.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  for (const lang of ["ja", "en"]) {
    const path = lang === "ja" ? "docs/helpers.ja.md" : "docs/helpers.md";
    let text = readFileSync(path, "utf8");
    for (const [name, content] of [
      ["regex", regexTable(report, lang)],
      ["audit", auditTable(report, lang)],
    ]) {
      text = text.replace(
        new RegExp(
          `<!-- helpers-${name}:begin -->[\\s\\S]*?<!-- helpers-${name}:end -->`,
        ),
        `<!-- helpers-${name}:begin -->\n${content}\n<!-- helpers-${name}:end -->`,
      );
    }
    writeFileSync(path, text);
  }
}
console.log(
  `Helpers and size probes passed: ${report.rows.length} configurations`,
);
