import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripUsedCounter } from "./import-contract.mjs";
import esbuild from "esbuild";
import { importNames, mangleProps } from "./import-contract.mjs";
mkdirSync("dist", { recursive: true });
let names;
for (const [variant, debug, mangle] of [
  ["release", false, true],
  ["debug", true, true],
  ["canonical", false, false],
]) {
  const b = await esbuild.build({
    entryPoints: ["src/host.mjs"],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    define: { __JSRT_DEBUG_ERRORS__: String(debug) },
    ...(mangle
      ? { mangleProps: new RegExp(mangleProps), mangleCache: names ?? {} }
      : {}),
  });
  writeFileSync(`dist/${variant}.mjs`, b.outputFiles[0].contents);
  if (mangle) {
    const current = Object.fromEntries(
      importNames.map((k) => [k, b.mangleCache[k]]),
    );
    if (names) assert.deepEqual(current, names);
    names = current;
  }
}
writeFileSync(
  "dist/private-imports.json",
  JSON.stringify(names, null, 2) + "\n",
);
console.log("Built release/debug JS host and private import map");
for (const debug of [false, true]) {
  const b = await esbuild.build({
    entryPoints: ["src/index.mjs"],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    define: { __JSRT_DEBUG_ERRORS__: String(debug) },
    mangleProps: new RegExp(mangleProps),
    mangleCache: { ...names },
  });
  writeFileSync(
    `dist/${debug ? "index-debug" : "index"}.mjs`,
    b.outputFiles[0].contents,
  );
}

for (const debug of [false, true]) {
  const b = await esbuild.build({
    entryPoints: ["src/jspi.mjs"],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    define: { __JSRT_DEBUG_ERRORS__: String(debug) },
  });
  writeFileSync(
    `dist/jspi${debug ? "-debug" : ""}.mjs`,
    b.outputFiles[0].contents,
  );
}

// The crates.io CLI embeds these ready-to-use assets. Consumers need neither
// this repository nor Node/esbuild to generate matching JS and Wasm.
const assetsRoot = "crates/kanimiso-cli/assets";
mkdirSync(assetsRoot, { recursive: true });
const assets = {
  "kanimiso.mjs": readFileSync("dist/index.mjs"),
  "kanimiso-debug.mjs": readFileSync("dist/index-debug.mjs"),
  "kanimiso-jspi.mjs": readFileSync("dist/jspi.mjs"),
  "kanimiso-jspi-debug.mjs": readFileSync("dist/jspi-debug.mjs"),
  "kanimiso-jspi.d.mts": readFileSync("src/jspi.d.ts"),
  "kanimiso.d.mts": readFileSync("src/index.d.ts"),
  "error-codes.json": readFileSync("src/error-codes.json"),
  "private-imports.json": readFileSync("dist/private-imports.json"),
  "intrusive.wat": Buffer.from(
    stripUsedCounter(readFileSync("src/intrusive.wat", "utf8")).replace(
      '(import "app" "memory"',
      '(import "kanimiso:core" "memory"',
    ),
  ),
  "intrusive-probes.wat": Buffer.from(
    readFileSync("src/intrusive.wat", "utf8").replace(
      '(import "app" "memory"',
      '(import "kanimiso:core" "memory"',
    ),
  ),
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [name, bytes] of Object.entries(assets))
  writeFileSync(`${assetsRoot}/${name}`, bytes);
const inputs = [
  "src/host.mjs",
  "src/errors.mjs",
  "src/error-codes.json",
  "src/index.mjs",
  "src/index.d.ts",
  "src/jspi.mjs",
  "src/jspi.d.ts",
  "src/intrusive.wat",
  "tools/build-host.mjs",
  "tools/import-contract.mjs",
  "package.json",
  "pnpm-lock.yaml",
];
writeFileSync(
  `${assetsRoot}/provenance.json`,
  JSON.stringify(
    {
      version: "0.1.0",
      esbuild: esbuild.version,
      inputs: Object.fromEntries(inputs.map((f) => [f, sha(readFileSync(f))])),
      assets: Object.fromEntries(
        Object.entries(assets).map(([f, b]) => [f, sha(b)]),
      ),
    },
    null,
    2,
  ) + "\n",
);
