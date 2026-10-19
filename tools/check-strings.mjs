import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { rustEnvironment } from "./rust-toolchain.mjs";
import { observeHelperRoots } from "../tests/support/helper-roots.mjs";
import { rolldown } from "rolldown";
import { stringsTable } from "./helpers-report.mjs";

const root = resolve("."),
  base = resolve(".cache/strings");
const cli = process.env.TARABA_LIBRARY_CLI || resolve("target/release/taraba");
const helpers =
  process.env.TARABA_LIBRARY_HELPERS || resolve("crates/taraba-helpers");
const allocator =
  process.env.TARABA_LIBRARY_ALLOCATOR || resolve("crates/taraba-allocator");
const env = {
  ...rustEnvironment(root),
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: resolve(".cache/strings-target"),
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
const texts = [
  "",
  "abc",
  "e\u0301",
  "é",
  "Ａ①",
  "蟹🦀",
  "👩‍👩‍👧‍👦",
  "🇯🇵🇨🇦",
  "\r\n",
  "  Straße  ",
  "吾輩は猫である。",
  "Hello, world! Next sentence.",
  "\uFEFF蟹",
  "가가",
  "Σσς",
  "a\u0301\u0327",
];
const rustStrings = texts
  .map((s) =>
    JSON.stringify(s).replace(/\\u([\da-f]{4})/gi, (_, hex) => `\\u{${hex}}`),
  )
  .join(",");
function digest(text) {
  let h = 2166136261;
  for (const b of new TextEncoder().encode(text))
    h = Math.imul(h ^ b, 16777619);
  return h | 0;
}
function expected(operation, index) {
  const s = texts[index];
  if (operation < 4)
    return digest(s.normalize(["NFC", "NFD", "NFKC", "NFKD"][operation]));
  if (operation === 4) return digest(s.toUpperCase());
  if (operation === 5) return digest(s.toLowerCase());
  if (operation === 6) return digest(s.trim());
  if (operation === 7) return digest([...s].join("|"));
  if (operation >= 8 && operation <= 10)
    return digest(
      [
        ...new Intl.Segmenter("ja", {
          granularity: ["grapheme", "word", "sentence"][operation - 8],
        }).segment(s),
      ]
        .map(
          (x) =>
            `${x.index}:${x.isWordLike === undefined ? 2 : +x.isWordLike}:${x.segment}`,
        )
        .join("|"),
    );
  if (operation === 11) return digest([...s].slice(0, 1).join("|"));
  if (operation === 12) return +/^é+$/u.test(s.normalize("NFC"));
  if (operation === 13) return index % 2 === 0 ? digest("あ") : -1;
  if (operation === 14) return s.length;
  if (operation === 15) {
    let out = "";
    for (const c of s) {
      if (new TextEncoder().encode(out + c).length > 3) break;
      out += c;
    }
    return digest(out);
  }
  throw Error("unknown operation");
}
const prelude = `extern crate alloc;
use taraba_helpers::{string::{JsString, Normalization},segmenter::{Segmenter,Granularity},encoding::Decoder,regexp::RegExp};
const TEXTS:[&str;${texts.length}]=[${rustStrings}];
fn hash(s:&str)->i32 { hash_bytes(s.as_bytes()) }
fn hash_bytes(bytes:&[u8])->i32 {bytes.iter().fold(2166136261u32,|h,&b|(h^b as u32).wrapping_mul(16777619))as i32}
fn js_hash(text:&JsString)->i32 {let mut bytes=[0u8;512];let len=text.write_utf8(&mut bytes);hash_bytes(&bytes[..len])}
`;
const full = `
fn process(op:i32,i:usize)->i32 {
 let s=JsString::from(TEXTS[i]);
 match op {
 0..=3=>js_hash(&s.normalize([Normalization::Nfc,Normalization::Nfd,Normalization::Nfkc,Normalization::Nfkd][op as usize])),
 4=>js_hash(&s.to_uppercase()),5=>js_hash(&s.to_lowercase()),6=>js_hash(&s.trim()),
 7=>hash(&s.code_points().map(|x|x.to_rust_string()).collect::<alloc::vec::Vec<_>>().join("|")),
 8..=10=>{let seg=Segmenter::new("ja",[Granularity::Grapheme,Granularity::Word,Granularity::Sentence][(op-8)as usize]).unwrap();hash(&seg.segment(&s).map(|x|alloc::format!("{}:{}:{}",x.index_utf16(),x.is_word_like().map_or(2,u32::from),x.text().to_rust_string())).collect::<alloc::vec::Vec<_>>().join("|"))},
 11=>hash(&s.code_points().take(1).map(|x|x.to_rust_string()).collect::<alloc::vec::Vec<_>>().join("|")),
 12=>i32::from(RegExp::new_js(&JsString::from("^é+$")).unwrap().is_match_js(&s.normalize(Normalization::Nfc))),
 13=>{let decoder=Decoder::new("shift_jis").unwrap();match decoder.decode(if i%2==0{&[0x82,0xa0]}else{&[0x82]}){Ok(s)=>js_hash(&s),Err(_)=>-1}},
 14=>s.utf16_len()as i32,
 _=>{let mut bytes=[0u8;3];let n=s.write_utf8(&mut bytes);hash_bytes(&bytes[..n])}
 }
}
`;
const variants = [
  {
    name: "unused",
    source:
      "fn process(_:i32,i:usize)->i32 {TEXTS[i].encode_utf16().count()as i32}",
    ops: [14],
  },
  {
    name: "utf16-len",
    source:
      "fn process(_:i32,i:usize)->i32 {JsString::from(TEXTS[i]).utf16_len()as i32}",
    ops: [14],
  },
  {
    name: "uppercase",
    source:
      "fn process(_:i32,i:usize)->i32 {js_hash(&JsString::from(TEXTS[i]).to_uppercase())}",
    ops: [4],
  },
  { name: "full", source: full, ops: Array.from({ length: 16 }, (_, i) => i) },
  {
    name: "normalize",
    source:
      "fn process(op:i32,i:usize)->i32 {js_hash(&JsString::from(TEXTS[i]).normalize([Normalization::Nfc,Normalization::Nfd,Normalization::Nfkc,Normalization::Nfkd][op as usize]))}",
    ops: [0, 1, 2, 3],
  },
  {
    name: "rust-normalize",
    dependencies:
      'unicode-normalization={version="=0.1.25",default-features=false}',
    source:
      "use unicode_normalization::UnicodeNormalization;fn process(op:i32,i:usize)->i32 {let s:alloc::string::String=match op{0=>TEXTS[i].nfc().collect(),1=>TEXTS[i].nfd().collect(),2=>TEXTS[i].nfkc().collect(),_=>TEXTS[i].nfkd().collect()};hash(&s)}",
    ops: [0, 1, 2, 3],
  },
  {
    name: "segment-count",
    source:
      'fn process(_:i32,i:usize)->i32 {Segmenter::new("ja",Granularity::Grapheme).unwrap().segment(&JsString::from(TEXTS[i])).count()as i32}',
    ops: [8],
    count: true,
  },
  {
    name: "rust-grapheme-count",
    dependencies:
      'unicode-segmentation={version="=1.13.3",default-features=false}',
    source:
      "use unicode_segmentation::UnicodeSegmentation;fn process(_:i32,i:usize)->i32 {TEXTS[i].graphemes(true).count()as i32}",
    ops: [8],
    count: true,
  },
  {
    name: "roundtrip",
    source:
      "fn process(_:i32,i:usize)->i32 {js_hash(&JsString::from(TEXTS[i]))}",
    ops: [0],
    roundtrip: true,
  },
  {
    name: "decoder",
    source:
      'fn process(_:i32,i:usize)->i32 {let decoder=Decoder::new("shift_jis").unwrap();match decoder.decode(if i%2==0{&[0x82,0xa0]}else{&[0x82]}){Ok(s)=>js_hash(&s),Err(_)=>-1}}',
    ops: [13],
  },
];
const report = {
  schema: 1,
  node: process.version,
  rustc: run("rustc", ["--version"]).trim(),
  binaryen: 133,
  safari_browser_verified: false,
  rows: [],
};
const old = existsSync("docs/strings-size.json")
  ? JSON.parse(readFileSync("docs/strings-size.json"))
  : {};
mkdirSync(base, { recursive: true });
for (const v of variants.filter(
  (v) => !process.env.TARABA_HELPERS_SMOKE || v.name === "full",
)) {
  const project = join(base, v.name);
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "wit"), { recursive: true });
  writeFileSync(
    join(project, "Cargo.toml"),
    `[package]\nname="strings-${v.name}"\nversion="0.1.0"\nedition="2024"\n[workspace]\n[lib]\ncrate-type=["cdylib"]\n[features]\nstd=[]\n[dependencies]\ntaraba-helpers={path=${JSON.stringify(helpers)},features=["regexp","strings","iterator","segmenter","encoding","alloc"]}\ntaraba-allocator={path=${JSON.stringify(allocator)},default-features=false}\n${v.dependencies || ""}\n[profile.release]\nopt-level="z"\nlto=true\ncodegen-units=1\npanic="abort"\nstrip=false\n`,
  );
  writeFileSync(
    join(project, "src/lib.rs"),
    `#![cfg_attr(not(feature="std"),no_std)]\n#[global_allocator]\nstatic ALLOC:taraba_allocator::Allocator=taraba_allocator::Allocator::INIT;\n#[cfg(not(feature="std"))]\n#[panic_handler]\nfn panic(_:&core::panic::PanicInfo)->!{core::arch::wasm32::unreachable()}\n${prelude}\n${v.source}\n#[unsafe(no_mangle)]pub extern "C" fn run(op:i32,index:i32)->i32 {process(op,index as u32 as usize%TEXTS.len())}\n`,
  );
  writeFileSync(
    join(project, "wit/app.wit"),
    "package test:strings;world app{export run:func(op:s32,index:s32)->s32;}\n",
  );
  const lock = old.rows?.find((r) => r.name === v.name)?.cargo_lock;
  if (lock) writeFileSync(join(project, "Cargo.lock"), lock);
  for (const std of [false, true]) {
    const output = join(project, std ? "std" : "no_std");
    run(
      cli,
      [
        "build",
        "--out-dir",
        output,
        "--insight",
        "--npm-name",
        `@taraba-test/strings-${v.name}`,
        ...(std ? ["--features", "std"] : []),
      ],
      project,
    );
    const { createHost } = await import(
      pathToFileURL(join(output, "index.js"))
    );
    const host = createHost(),
      observed = observeHelperRoots(host);
    const bytes = readFileSync(join(output, "app.wasm"));
    const { instance } = await WebAssembly.instantiate(bytes, host.imports);
    host.attach(instance.exports);
    const bundle = await rolldown({ input: join(output, "index.js") });
    let bundled;
    try {
      const { output: chunks } = await bundle.generate({
        format: "esm",
        minify: true,
        comments: false,
      });
      assert.equal(chunks.length, 1);
      bundled = chunks[0].code;
    } finally {
      await bundle.close();
    }
    const bundledModule = await import(
      `data:text/javascript;base64,${Buffer.from(bundled).toString("base64")}`
    );
    const bundledHost = bundledModule.createHost();
    const bundledRoots = observeHelperRoots(bundledHost);
    const linked = await WebAssembly.instantiate(bytes, bundledHost.imports);
    bundledHost.attach(linked.instance.exports);
    let tests = 0;
    for (const op of v.ops)
      for (let i = 0; i < texts.length; i++) {
        const value = v.count
          ? [
              ...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(
                texts[i],
              ),
            ].length
          : v.roundtrip
            ? digest(texts[i])
            : expected(op, i);
        for (const [h, roots] of [
          [host, observed],
          [bundledHost, bundledRoots],
        ]) {
          assert.equal(
            await h.run(op, i),
            value,
            `${v.name}/${std}/${op}/${i}`,
          );
          assert.equal(
            roots.total(),
            0,
            "all input/item/cursor roots released",
          );
        }
        tests++;
      }
    const info = JSON.parse(readFileSync(join(output, "build.json")));
    assert.equal(info.profile, "wit-core-jspi");
    const files = readdirSync(output).filter((f) => /\.m?js$/.test(f));
    const js = files.reduce(
      (n, f) => n + readFileSync(join(output, f)).length,
      0,
    );
    assert.equal(info.js_bytes, js);
    if (v.name === "normalize" || v.name === "roundtrip") {
      assert.ok(!files.includes("helpers-iterator.mjs"));
      assert.ok(!files.includes("helpers-segmenter.mjs"));
      assert.ok(!files.includes("helpers-encoding.mjs"));
    }
    if (v.name.startsWith("rust-") || v.name === "unused")
      assert.ok(
        !files.some((f) => f.startsWith("helpers-")),
        "unused helpers must add no JS",
      );
    const stringCode = files.includes("helpers-strings.mjs")
      ? readFileSync(join(output, "helpers-strings.mjs"), "utf8")
      : "";
    const retained = Object.keys(
      host.imports["taraba:helpers/strings@0.1.0"] || {},
    ).sort();
    const expectedImports = {
      "utf16-len": ["from-utf8", "utf16-len"],
      uppercase: ["copy-utf8", "from-utf8", "to-uppercase"],
      normalize: ["copy-utf8", "from-utf8", "normalize"],
      roundtrip: ["copy-utf8", "from-utf8"],
      decoder: ["copy-utf8", "from-utf8"],
      "segment-count": ["from-utf8"],
      unused: [],
    }[v.name];
    if (expectedImports) assert.deepEqual(retained, expectedImports);
    if (v.name === "utf16-len" || v.name === "segment-count")
      assert.ok(!stringCode.includes("TextEncoder"), "unused encoder excluded");
    if (v.name === "uppercase")
      for (const method of [
        "normalize",
        "toLowerCase",
        "trim",
        "Symbol.iterator",
      ])
        assert.ok(!stringCode.includes(method), `unused ${method}`);
    if (v.name === "segment-count") {
      const methods = host.imports["taraba:helpers/segmenter@0.1.0"];
      assert.deepEqual(Object.keys(methods).sort(), ["new", "segment"]);
    }
    if (v.name === "full") {
      const packed = join(project, `pack-${std}`);
      mkdirSync(packed, { recursive: true });
      run("pnpm", ["pack", "--pack-destination", packed], output);
      const archive = join(
        packed,
        readdirSync(packed).find((f) => f.endsWith(".tgz")),
      );
      assert.ok(!run("tar", ["-tzf", archive]).includes(".taraba/"));
      const consumer = mkdtempSync(join(tmpdir(), "taraba-strings-"));
      try {
        writeFileSync(
          join(consumer, "package.json"),
          '{"private":true,"type":"module"}\n',
        );
        run(
          "pnpm",
          ["add", "--offline", "--ignore-scripts", archive],
          consumer,
        );
        writeFileSync(
          join(consumer, "consumer.mts"),
          "import {createHost} from '@taraba-test/strings-full';const h=createHost();h.run(0,1).then((n:number)=>n);\n// @ts-expect-error WIT arguments are numeric\nh.run('bad',1);\n",
        );
        run(
          resolve("node_modules/.bin/tsc"),
          [
            "--strict",
            "--noEmit",
            "--module",
            "NodeNext",
            "--target",
            "ES2022",
            "--lib",
            "ES2022,DOM",
            "consumer.mts",
          ],
          consumer,
        );
        const installed = join(
          consumer,
          "node_modules/@taraba-test/strings-full",
        );
        const { createHost } = await import(
          pathToFileURL(join(installed, "index.js"))
        );
        const h = createHost();
        const { instance } = await WebAssembly.instantiate(
          readFileSync(join(installed, "app.wasm")),
          h.imports,
        );
        h.attach(instance.exports);
        assert.equal(await h.run(0, 2), expected(0, 2));
      } finally {
        rmSync(consumer, { recursive: true, force: true });
      }
    }
    report.rows.push({
      name: v.name,
      std,
      tests,
      wasm_bytes: bytes.length,
      js_bytes: js,
      bundled_js_bytes: Buffer.byteLength(bundled),
      total_bytes: bytes.length + js,
      helper_files: files.filter((f) => f.startsWith("helpers-")),
      cargo_lock: readFileSync(join(project, "Cargo.lock"), "utf8"),
    });
    console.log(
      `strings ${v.name}/${std ? "std" : "no_std"}: ${bytes.length} B Wasm + ${js} B JS (${Buffer.byteLength(bundled)} B Rolldown); ${tests} cases, no live roots`,
    );
  }
}
report.all_passed = true;
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
    "tools/check-strings.mjs",
    "tools/helpers-report.mjs",
    "tools/helper-assets.mjs",
    "package.json",
    "pnpm-lock.yaml",
    "tests/support/helper-roots.mjs",
    "crates/taraba-helpers/Cargo.toml",
    "crates/taraba-allocator/Cargo.toml",
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
  report.inputs = Object.fromEntries(
    inputs
      .sort()
      .map((f) => [
        f,
        createHash("sha256").update(readFileSync(f)).digest("hex"),
      ]),
  );
  writeFileSync(
    "docs/strings-size.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  for (const lang of ["ja", "en"]) {
    const path = lang === "ja" ? "docs/strings.ja.md" : "docs/strings.md";
    const text = readFileSync(path, "utf8").replace(
      /<!-- strings-size:begin -->[\s\S]*?<!-- strings-size:end -->/,
      `<!-- strings-size:begin -->\n${stringsTable(report, lang)}\n<!-- strings-size:end -->`,
    );
    writeFileSync(path, text);
  }
}
