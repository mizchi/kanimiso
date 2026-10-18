#!/usr/bin/env node
// Contributor wrapper; installed users run the native taraba CLI directly.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
const args = process.argv.slice(2),
  option = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
if (!args[0] || !option("--wit") || !option("--output"))
  throw Error(
    "usage: node tools/build-wasm.mjs raw.wasm --wit path --output app.wasm [--probes]",
  );
const run = (bin, argv) =>
  execFileSync(bin, argv, { stdio: "pipe", maxBuffer: 32 * 1024 * 1024 });
run("cargo", ["build", "--locked", "--release", "-p", "taraba-cli"]);
const temp = mkdtempSync(resolve(tmpdir(), "taraba-build-"));
try {
  run(resolve("target/release/taraba"), [
    "build",
    resolve(args[0]),
    "--wit",
    resolve(option("--wit")),
    "--out-dir",
    temp,
    "--binaryen",
    resolve(".cache/toolchains/binaryen-version_133/bin"),
    ...(args.includes("--probes") ? ["--probes"] : []),
    ...(args.includes("--jspi") ? ["--jspi"] : []),
  ]);
  mkdirSync(dirname(resolve(option("--output"))), { recursive: true });
  copyFileSync(`${temp}/app.wasm`, resolve(option("--output")));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
