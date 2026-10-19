import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import esbuild from "esbuild";
import { asyncCases } from "../tests/support/async-contract.mjs";
import { verifyJspi } from "../tests/support/jspi.mjs";
const cases = [1, 16, 128, 1024].flatMap(asyncCases);
const modules = ["no_std", "std"].map((mode) => ({
  mode,
  bytes: Array.from(readFileSync(`dist/examples/jspi-${mode}-minimal.wasm`)),
  probes: Array.from(readFileSync(`dist/examples/jspi-${mode}-probes.wasm`)),
}));
const report = {
  engine_baseline:
    "Safari 27+ / JSPI-capable V8; old system JSC is outside the baseline",
  engines: [],
};
for (const debug of [false, true]) {
  const { createHost } = await import(
    `../dist/jspi${debug ? "-debug" : ""}.mjs`
  );
  const result = await verifyJspi(createHost, modules, cases);
  assert.equal(result.all_passed, true);
  report.engines.push({
    name: `Node ${process.version} / V8 ${process.versions.v8}`,
    debug,
    eligible: true,
    result,
  });
}
const dir = ".cache/jspi-check";
mkdirSync(dir, { recursive: true });
const jsc =
  "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";
if (existsSync(jsc)) {
  const source = `import {createHost} from ${JSON.stringify(resolve("dist/jspi.mjs"))};import {verifyJspi} from ${JSON.stringify(resolve("tests/support/jspi.mjs"))};const capabilities={promising:typeof WebAssembly.promising,suspending:typeof WebAssembly.Suspending};if(capabilities.promising!=='function'||capabilities.suspending!=='function'){print(JSON.stringify({eligible:false,reason:'JSPI unavailable; outside Safari 27+ baseline',capabilities}));}else{verifyJspi(createHost,${JSON.stringify(modules)},${JSON.stringify(cases)}).then(result=>print(JSON.stringify({eligible:true,result})),error=>print(JSON.stringify({eligible:true,error:String(error)})));}`;
  const built = await esbuild.build({
    stdin: { contents: source, resolveDir: resolve(".") },
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
  if (result.eligible)
    assert.equal(result.result?.all_passed, true, result.error);
  report.engines.push({
    name: "system JavaScriptCore shell (not Safari 27 browser verification)",
    ...result,
  });
}
report.all_eligible_passed = true;
writeFileSync(".cache/jspi-check.json", JSON.stringify(report, null, 2) + "\n");
console.log(
  "JSPI release/debug × std/no_std: frozen inputs and Rust stack spills passed; old JSC is classified outside baseline.",
);
