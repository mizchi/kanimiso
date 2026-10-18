import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import esbuild from "esbuild";
import { optimizationArgs } from "./wasm-opt-contract.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";
import { verifyModern } from "../tests/support/modern.mjs";
import { createHost } from "../dist/release.mjs";
const dir = ".cache/modern",
  fixtures = {};
mkdirSync(dir, { recursive: true });
for (const name of ["js-string", "exnref", "funcref", "gc"]) {
  const artifact = `${dir}/${name}.wasm`;
  execFileSync(".cache/toolchains/binaryen-version_133/bin/wasm-as", [
    `tests/fixtures/${name}.wat`,
    ...optimizationArgs("Oz").filter((s) => s.startsWith("--enable-")),
    "-o",
    artifact,
  ]);
  fixtures[name] = Array.from(readFileSync(artifact));
}
const modules = ["no_std", "std"].map((mode) => ({
    mode,
    bytes: Array.from(readFileSync(`dist/examples/${mode}-minimal.wasm`)),
  })),
  cases = [1, 16, 128, 1024].flatMap((c) => asyncCases(c));
const node = await verifyModern(fixtures, createHost, modules, cases);
assert.equal(node.all_passed, true);
const engines = [
  { name: `Node ${process.version} / V8 ${process.versions.v8}`, result: node },
];
const jsc =
  "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";
if (existsSync(jsc)) {
  const entry = `${dir}/entry.mjs`;
  writeFileSync(
    entry,
    `import {verifyModern} from ${JSON.stringify(resolve("tests/support/modern.mjs"))};import {createHost} from ${JSON.stringify(resolve("dist/release.mjs"))};verifyModern(${JSON.stringify(fixtures)},createHost,${JSON.stringify(modules)},${JSON.stringify(cases)}).then(r=>print(JSON.stringify(r)),e=>print(JSON.stringify({all_passed:false,error:String(e)})));`,
  );
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "neutral",
    write: false,
    target: "es2022",
  });
  writeFileSync(
    `${dir}/jsc.js`,
    "globalThis.queueMicrotask=fn=>{Promise.resolve().then(fn);};\n" +
      built.outputFiles[0].text,
  );
  const result = JSON.parse(
    execFileSync(jsc, [`${dir}/jsc.js`], {
      encoding: "utf8",
      timeout: 60000,
    }).trim(),
  );
  assert.deepEqual(result, node);
  engines.push({
    name: "system JavaScriptCore shell",
    limitation:
      "Not a Safari browser test; queueMicrotask supplied via Promise job",
    result,
  });
}
writeFileSync(
  ".cache/modern.json",
  JSON.stringify({ engines, all_passed: true }, null, 2) + "\n",
);
console.log(engines.map((e) => `${e.name}: passed`).join("\n"));
