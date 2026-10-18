import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
