import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rustEnvironment } from "./rust-toolchain.mjs";
const root = resolve("."),
  cli = resolve("target/release/taraba"),
  temp = mkdtempSync(join(tmpdir(), "taraba-browser-"));
const env = {
  ...rustEnvironment(root),
  TARABA_BINDGEN: cli,
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_TARGET_DIR: resolve(".cache/browser-target"),
};
const run = (bin, args, cwd = temp) =>
  execFileSync(bin, args, {
    cwd,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
try {
  for (const profile of ["future", "jspi"]) {
    const project = join(temp, profile);
    run(cli, ["new", project, "--no-std", `--${profile}`]);
    const manifest = join(project, "Cargo.toml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8") +
        `\n[patch.crates-io]\ntaraba={path=${JSON.stringify(join(root, "crates/taraba"))}}\ntaraba-allocator={path=${JSON.stringify(join(root, "crates/taraba-allocator"))}}\n`,
    );
    if (profile === "future") {
      writeFileSync(
        join(project, "wit/app.wit"),
        `package test:browser; interface handles {resource value {constructor(text:string);}read:async func(v:borrow<value>)->string;} world app {import io:handles;use handles.{value};record packet {id:u64,label:string,payload:list<u8>} import exchange:async func(v:packet)->packet; export run:async func(v:packet)->packet; export grow:func(pages:u32)->u32;export make:async func()->own<value>;export inspect:async func(v:borrow<value>)->string;export consume:async func(v:own<value>)->u32;}`,
      );
      const lib = join(project, "src/lib.rs"),
        prefix = readFileSync(lib, "utf8").split("include!(")[0];
      writeFileSync(
        lib,
        prefix +
          `include!(concat!(env!("OUT_DIR"),"/bindings.rs"));bindings!();struct App;impl Guest for App {async fn run(v:Packet)->HostResult<Packet>{exchange(v).await} fn grow(pages:u32)->u32{core::arch::wasm32::memory_grow::<0>(pages as usize) as u32} async fn make()->HostResult<HandlesValue>{Ok(imports::io::value("resource 🦀".into()))} async fn inspect(v:Borrowed<HandlesValue>)->HostResult<__taraba_types::alloc::string::String>{imports::io::read(&v).await} async fn consume(v:HandlesValue)->HostResult<u32>{drop(v);Ok(7)}}export!(App);`,
      );
    }
    run(
      cli,
      [
        "build",
        "--out-dir",
        join(root, ".cache/browser", profile),
        ...(profile === "future" ? ["--abort-signal"] : []),
      ],
      project,
    );
  }
  mkdirSync(".cache/browser", { recursive: true });
  writeFileSync(
    ".cache/browser/index.html",
    `<!doctype html><meta charset="utf-8"><title>taraba browser contracts</title>`,
  );
  console.log("Built browser consumer packages");
} catch (e) {
  writeFileSync(
    ".cache/browser-fixtures-error.log",
    `${e.stack}\n${e.stdout || ""}\n${e.stderr || ""}`,
  );
  throw e;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
