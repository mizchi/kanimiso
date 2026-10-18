#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renameImports, stripUsedCounter } from "./import-contract.mjs";
import { optimizationArgs } from "./wasm-opt-contract.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Paths are relative to the caller, not to the package installation.
const args = process.argv.slice(2),
  raw = args[0];
const option = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
if (!raw || !option("--abi") || !option("--output"))
  throw Error(
    "usage: kanimiso-build raw.wasm --abi abi.json --output app.wasm [--probes] [--canonical]",
  );
const input = resolve(raw),
  abi = resolve(option("--abi")),
  output = resolve(option("--output"));
if (output === input) throw Error("output must not overwrite input");
const run = (bin, argv) =>
  execFileSync(bin, argv, {
    cwd: root,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
const binaryen = resolve(root, ".cache/toolchains/binaryen-version_133/bin");
if (!existsSync(`${binaryen}/wasm-opt`))
  throw Error("Binaryen 133 missing; run just setup");
if (!existsSync(resolve(root, "dist/private-imports.json")))
  throw Error("JS host missing; run just build-host");
const temp = resolve(root, ".cache/build", Date.now() + "-" + process.pid);
mkdirSync(temp, { recursive: true });
mkdirSync(dirname(output), { recursive: true });
run("cargo", ["build", "--locked", "--release", "-p", "kanimiso-bind"]);
run(resolve(root, "target/release/kanimiso-bind"), [
  input,
  `${temp}/core.wasm`,
  abi,
]);
const core = readFileSync(`${temp}/core.wasm`),
  module = new WebAssembly.Module(core),
  exports = WebAssembly.Module.exports(module);
const wat = readFileSync(resolve(root, "src/intrusive.wat"), "utf8").replace(
  '(import "app" "memory"',
  '(import "kanimiso:core" "memory"',
);
writeFileSync(
  `${temp}/slots.wat`,
  args.includes("--probes") ? wat : stripUsedCounter(wat),
);
run(`${binaryen}/wasm-as`, [`${temp}/slots.wat`, "-o", `${temp}/slots.wasm`]);
const flags = optimizationArgs("Oz").filter((s) => s.startsWith("--enable-"));
run(`${binaryen}/wasm-merge`, [
  `${temp}/core.wasm`,
  "kanimiso:core",
  `${temp}/slots.wasm`,
  "pool",
  ...flags,
  "-o",
  `${temp}/merged.wasm`,
]);
const graph = [
  ...exports.map((e) => ({
    name: `host:${e.name}`,
    export: e.name,
    root: true,
  })),
  ...["allocate", "free", "used"].map((name) => ({
    name: `internal:${name}`,
    export: name,
  })),
];
writeFileSync(`${temp}/graph.json`, JSON.stringify(graph));
run(`${binaryen}/wasm-metadce`, [
  `${temp}/merged.wasm`,
  ...flags,
  "--graph-file",
  `${temp}/graph.json`,
  "-o",
  `${temp}/linked.wasm`,
]);
run(`${binaryen}/wasm-opt`, [
  `${temp}/linked.wasm`,
  ...optimizationArgs("Oz"),
  "--flatten",
  "--rereloop",
  "-Oz",
  "--converge",
  "-o",
  `${temp}/optimized.wasm`,
]);
const names = JSON.parse(
    readFileSync(resolve(root, "dist/private-imports.json")),
  ),
  optimized = readFileSync(`${temp}/optimized.wasm`);
const bytes = args.includes("--canonical")
  ? optimized
  : renameImports(optimized, names);
const compiled = new WebAssembly.Module(bytes);
assert.deepEqual(WebAssembly.Module.exports(compiled), exports);
assert.ok(
  WebAssembly.Module.imports(compiled).every(
    (i) => i.module === "jsrt" || i.module === "app",
  ),
);
writeFileSync(output, bytes);
console.log(`${output}: ${bytes.length} B`);
