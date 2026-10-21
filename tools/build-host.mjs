import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripUsedCounter } from "./import-contract.mjs";
import { rolldown, VERSION as rolldownVersion } from "rolldown";
import { helperOperations } from "./helper-assets.mjs";
import { importNames, mangleProps } from "./import-contract.mjs";
async function bundleAsset(entry, define, cache) {
  const bundle = await rolldown({
    input: entry,
    platform: "neutral",
    transform: { target: "es2022", define },
  });
  try {
    const result = await bundle.generate({
      format: "esm",
      comments: false,
      minify: cache
        ? { mangleProps: { include: new RegExp(mangleProps), cache } }
        : true,
    });
    assert.equal(result.output.length, 1, `${entry}: self-contained runtime`);
    return {
      contents: Buffer.from(result.output[0].code),
      mangleCache: result.mangleCache,
    };
  } finally {
    await bundle.close();
  }
}
mkdirSync("dist", { recursive: true });
let names;
for (const [variant, debug, mangle] of [
  ["release", false, true],
  ["debug", true, true],
  ["canonical", false, false],
]) {
  const b = await bundleAsset(
    "src/host.mjs",
    { __JSRT_DEBUG_ERRORS__: String(debug), __TARABA_ABORT__: "false" },
    mangle ? (names ?? {}) : undefined,
  );
  writeFileSync(`dist/${variant}.mjs`, b.contents);
  if (mangle) {
    const current = Object.fromEntries(
      importNames.map((k) => [k, b.mangleCache[k]]),
    );
    if (names) assert.deepEqual(current, names);
    names = current;
  }
}
for (const [variant, debug, mangle] of [
  ["abort", false, true],
  ["abort-debug", true, true],
  ["abort-canonical", false, false],
]) {
  const b = await bundleAsset(
    "src/host.mjs",
    {
      __JSRT_DEBUG_ERRORS__: String(debug),
      __TARABA_ABORT__: "true",
    },
    mangle ? names : undefined,
  );
  if (mangle)
    assert.deepEqual(
      Object.fromEntries(importNames.map((k) => [k, b.mangleCache[k]])),
      names,
    );
  writeFileSync(`dist/${variant}.mjs`, b.contents);
}
writeFileSync(
  "dist/private-imports.json",
  JSON.stringify(names, null, 2) + "\n",
);
console.log("Built release/debug JS host and private import map");
// Discard obsolete loader artifacts from earlier local builds.
for (const file of ["dist/index.mjs", "dist/index-debug.mjs"])
  rmSync(file, { force: true });

for (const debug of [false, true]) {
  const b = await bundleAsset("src/jspi.mjs", {
    __JSRT_DEBUG_ERRORS__: String(debug),
  });
  writeFileSync(`dist/jspi${debug ? "-debug" : ""}.mjs`, b.contents);
}

// The crates.io CLI embeds these ready-to-use assets. Consumers need neither
// this repository nor a JavaScript bundler to generate matching JS and Wasm.
const assetsRoot = "crates/taraba-cli/assets";
mkdirSync(assetsRoot, { recursive: true });
rmSync(`${assetsRoot}/error-codes.json`, { force: true });
const assets = {
  "LICENSE.taraba-allocator": readFileSync("crates/taraba-allocator/LICENSE"),
  "UPSTREAM.taraba-allocator.json": readFileSync(
    "crates/taraba-allocator/UPSTREAM.json",
  ),
  "NOTICE.taraba": Buffer.from(
    readFileSync("tools/npm-notice.txt", "utf8").replaceAll(
      "__ALLOCATOR_VERSION__",
      readFileSync("crates/taraba-allocator/Cargo.toml", "utf8").match(
        /^version = "([^"]+)"/m,
      )[1],
    ),
  ),
  "helper-operations.json": await helperOperations(),
  "regexp.wit": readFileSync("crates/taraba-helpers/wit/regexp.wit"),
  "text.wit": readFileSync("crates/taraba-helpers/wit/text.wit"),
  "taraba.mjs": readFileSync("dist/release.mjs"),
  "taraba-abort.mjs": readFileSync("dist/abort.mjs"),
  "taraba-abort-debug.mjs": readFileSync("dist/abort-debug.mjs"),
  "taraba-debug.mjs": readFileSync("dist/debug.mjs"),
  "taraba-jspi.mjs": readFileSync("dist/jspi.mjs"),
  "taraba-jspi-debug.mjs": readFileSync("dist/jspi-debug.mjs"),
  "taraba-jspi.d.mts": readFileSync("src/jspi.d.ts"),
  "taraba.d.mts": readFileSync("src/host.d.ts"),
  "private-imports.json": readFileSync("dist/private-imports.json"),
  "intrusive.wat": Buffer.from(
    stripUsedCounter(readFileSync("src/intrusive.wat", "utf8")).replace(
      '(import "app" "memory"',
      '(import "taraba:core" "memory"',
    ),
  ),
  "intrusive-probes.wat": Buffer.from(
    readFileSync("src/intrusive.wat", "utf8").replace(
      '(import "app" "memory"',
      '(import "taraba:core" "memory"',
    ),
  ),
};
for (const debug of [false, true]) {
  for (const [entry, name, strings] of [
    ["regexp", "regexp", false],
    ["regexp", "regexp-strings", true],
    ["helper-values", "helper-values", false],
  ]) {
    const b = await bundleAsset(`src/${entry}.mjs`, {
      __JSRT_DEBUG_ERRORS__: String(debug),
      __TARABA_STRINGS__: String(strings),
    });
    assets[`${name}${debug ? "-debug" : ""}.mjs`] = b.contents;
  }
}
for (const name of ["strings", "iterator", "segmenter", "encoding"])
  for (const suffix of ["", "-debug"])
    rmSync(`${assetsRoot}/${name}${suffix}.mjs`, { force: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [name, bytes] of Object.entries(assets))
  writeFileSync(`${assetsRoot}/${name}`, bytes);
const inputs = [
  "tools/npm-notice.txt",
  "crates/taraba-allocator/Cargo.toml",
  "crates/taraba-allocator/LICENSE",
  "crates/taraba-allocator/UPSTREAM.json",
  "src/host.mjs",
  "src/errors.mjs",
  "src/panic.mjs",
  "src/regexp.mjs",
  "src/helper-values.mjs",
  "src/strings.mjs",
  "src/iterator.mjs",
  "src/segmenter.mjs",
  "src/encoding.mjs",
  "crates/taraba-helpers/wit/regexp.wit",
  "crates/taraba-helpers/wit/text.wit",
  "src/error-codes.json",
  "src/host.d.ts",
  "src/jspi.mjs",
  "src/jspi.d.ts",
  "src/intrusive.wat",
  "tools/build-host.mjs",
  "tools/helper-assets.mjs",
  "tools/import-contract.mjs",
  "package.json",
  "pnpm-lock.yaml",
];
writeFileSync(
  `${assetsRoot}/provenance.json`,
  JSON.stringify(
    {
      version: JSON.parse(readFileSync("package.json", "utf8")).version,
      rolldown: rolldownVersion,
      inputs: Object.fromEntries(inputs.map((f) => [f, sha(readFileSync(f))])),
      assets: Object.fromEntries(
        Object.entries(assets).map(([f, b]) => [f, sha(b)]),
      ),
    },
    null,
    2,
  ) + "\n",
);
