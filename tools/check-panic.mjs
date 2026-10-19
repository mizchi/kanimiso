import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { rustEnvironment } from "./rust-toolchain.mjs";

const root = resolve(".cache/panic-reporting");
mkdirSync(join(root, "src"), { recursive: true });
const env = {
  ...rustEnvironment(resolve(".")),
  CARGO_TARGET_DIR: join(root, "target"),
  TARABA_BINARYEN: resolve(".cache/toolchains/binaryen-version_133/bin"),
  CARGO_ENCODED_RUSTFLAGS: [
    "-C",
    "link-arg=-zstack-size=65536",
    "-C",
    "link-arg=--max-memory=1048576",
  ].join("\x1f"),
};
const run = (bin, args) => execFileSync(bin, args, { env, stdio: "pipe" });
writeFileSync(
  join(root, "Cargo.toml"),
  `[package]
name="taraba-panic-check"
version="0.0.0"
edition="2024"
[workspace]
[lib]
crate-type=["cdylib"]
[features]
default=[]
std=["taraba/std"]
hook=[]
future=[]
panic-details=["taraba/panic-details"]
[dependencies]
taraba={path=${JSON.stringify(resolve("crates/taraba"))},default-features=false}
taraba-allocator={path=${JSON.stringify(resolve("crates/taraba-allocator"))},default-features=false}
[profile.release]
opt-level="z"
lto=true
codegen-units=1
panic="abort"
strip=false
[profile.dev]
panic="abort"
`,
);
writeFileSync(
  join(root, "src/lib.rs"),
  `#![cfg_attr(not(feature="std"),no_std)]
extern crate alloc;
#[global_allocator]
static ALLOCATOR:taraba_allocator::Allocator=taraba_allocator::Allocator::INIT;
static FORMATTED:core::sync::atomic::AtomicU32=core::sync::atomic::AtomicU32::new(0);
struct Payload(i32);
impl core::fmt::Display for Payload {
    fn fmt(&self,f:&mut core::fmt::Formatter<'_>)->core::fmt::Result {
        FORMATTED.fetch_add(1,core::sync::atomic::Ordering::Relaxed);
        write!(f,"panic sentinel 日本語: n={}",self.0)
    }
}
#[unsafe(export_name="format-count-pointer")] pub extern "C" fn format_count_pointer()->u32 {FORMATTED.as_ptr() as u32}
#[cfg(not(feature="std"))] #[panic_handler]
fn panic(info:&core::panic::PanicInfo)->! {
    #[cfg(feature="hook")] {taraba::panic::handler(info)}
    #[cfg(not(feature="hook"))] {let _=info;core::arch::wasm32::unreachable()}
}
#[unsafe(no_mangle)] pub extern "C" fn run(n:i32)->i32 {
    #[cfg(all(feature="std",feature="hook"))] taraba::panic::set_hook();
    if n<0 {panic!("{}",Payload(n));}
    n.wrapping_mul(3).wrapping_add(1)
}
#[unsafe(no_mangle)] pub extern "C" fn formatted(n:i32)->i32 {
    alloc::format!("value={n}").len() as i32
}
#[unsafe(no_mangle)] pub extern "C" fn trap() {core::arch::wasm32::unreachable()}
#[unsafe(export_name="custom-hook")] pub extern "C" fn custom_hook() {
    #[cfg(all(feature="std",feature="hook"))]
    std::panic::set_hook(alloc::boxed::Box::new(|_|core::arch::wasm32::unreachable()));
}
#[cfg(feature="future")] taraba::export_runtime!();
#[cfg(feature="future")] #[unsafe(no_mangle)] pub extern "C" fn start(n:i32)->u32 {
    #[cfg(all(feature="std",feature="hook"))] taraba::panic::set_hook();
    taraba::future_to_promise(async move {
        core::future::ready(()).await;
        Ok(taraba::JsValue::from_i32(run(n)))
    }).into_abi()
}
`,
);
const rows = [];
for (const profile of ["jspi", "future"]) {
  const wit = join(root, `${profile}.wit`);
  writeFileSync(
    wit,
    `package test:panic; ${profile === "future" ? "interface js {resource promise;}" : ""}
world app {
${profile === "future" ? "import js; use js.{promise}; export start:func(n:s32)->promise;" : ""}
export run:func(n:s32)->s32; export formatted:func(n:s32)->s32; export trap:func(); export custom-hook:func(); export format-count-pointer:func()->u32;
}`,
  );
  for (const std of [false, true]) {
    for (const variant of ["baseline", "release", "debug", "details"]) {
      const features = [
        ...(std ? ["std"] : []),
        ...(profile === "future" ? ["future"] : []),
        ...(variant !== "baseline" ? ["hook"] : []),
        ...(variant === "details" ? ["panic-details"] : []),
      ];
      run("cargo", [
        "build",
        "--manifest-path",
        join(root, "Cargo.toml"),
        "--target",
        "wasm32-unknown-unknown",
        ...(variant === "debug" ? [] : ["--release"]),
        "--features",
        features.join(","),
      ]);
      const raw = join(
        env.CARGO_TARGET_DIR,
        "wasm32-unknown-unknown",
        variant === "debug" ? "debug" : "release",
        "taraba_panic_check.wasm",
      );
      const output = join(
        root,
        `${profile}-${std ? "std" : "no_std"}-${variant}`,
      );
      const args = [
        "build",
        raw,
        "--wit",
        wit,
        "--out-dir",
        output,
        `--${profile}`,
      ];
      if (variant === "debug" || variant === "details") args.push("--debug");
      run(resolve("target/release/taraba"), args);
      const { createHost } = await import(
        pathToFileURL(join(output, "index.js"))
      );
      const bytes = readFileSync(join(output, "app.wasm"));
      const memories = new WeakMap();
      const instantiate = async () => {
        const host = createHost();
        const { instance } = await WebAssembly.instantiate(bytes, host.imports);
        host.attach(instance.exports);
        memories.set(host, instance.exports.memory);
        return host;
      };
      const host = await instantiate();
      for (const n of [0, 1, 42, 2147483647]) {
        assert.equal(await host.run(n), (Math.imul(n, 3) + 1) | 0);
        assert.equal(
          await host.formatted(n),
          `value=${n}`.length,
          "normal formatting must remain intact",
        );
        if (profile === "future")
          assert.equal(await host.start(n), (Math.imul(n, 3) + 1) | 0);
      }
      let fatal;
      const counter = await host["format-count-pointer"]();
      await assert.rejects(
        profile === "future" ? host.start(-1) : host.run(-1),
        (e) => {
          fatal = e;
          if (variant === "baseline")
            assert.ok(e instanceof WebAssembly.RuntimeError);
          else {
            assert.equal(e.code, "PN01");
            assert.ok(e.message.includes("docs/error-codes.md#pn01"));
            assert.equal(
              e.message.includes("panic sentinel 日本語: n=-1"),
              variant !== "release",
            );
            assert.equal(
              e.message.includes("src/lib.rs"),
              variant !== "release",
            );
          }
          return true;
        },
      );
      assert.equal(host.stats().dead, true);
      // Read memory without re-entering the poisoned guest. std can construct
      // the payload before invoking a hook, even when our hook ignores it.
      const payloadFormats = new DataView(memories.get(host).buffer).getUint32(
        counter,
        true,
      );
      if (variant !== "baseline")
        assert.equal(payloadFormats, std || variant !== "release" ? 1 : 0);
      await assert.rejects(host.run(1), (e) => e === fatal);
      if (profile === "future") {
        const stats = host.stats();
        assert.equal(
          stats.live_tasks + stats.live_waits + stats.live_values,
          0,
        );
      }
      const native = await instantiate();
      await assert.rejects(
        native.trap(),
        (e) => e instanceof WebAssembly.RuntimeError && e.code === undefined,
      );
      if (std && variant !== "baseline") {
        const custom = await instantiate();
        await custom.run(0);
        await custom["custom-hook"]();
        await assert.rejects(
          custom.run(-1),
          (e) => e instanceof WebAssembly.RuntimeError && e.code === undefined,
        );
      }
      // JS release must discard even explicitly enabled Rust diagnostic text.
      if (variant === "details") {
        const release = join(
          root,
          `${profile}-${std ? "std" : "no_std"}-details-release-js`,
        );
        run(resolve("target/release/taraba"), [
          "build",
          raw,
          "--wit",
          wit,
          "--out-dir",
          release,
          `--${profile}`,
        ]);
        const { createHost: releaseHost } = await import(
          pathToFileURL(join(release, "index.js"))
        );
        const h = releaseHost();
        const { instance } = await WebAssembly.instantiate(
          readFileSync(join(release, "app.wasm")),
          h.imports,
        );
        h.attach(instance.exports);
        await assert.rejects(
          h.run(-1),
          (e) => e.code === "PN01" && !e.message.includes("panic sentinel"),
        );
      }
      const info = JSON.parse(readFileSync(join(output, "build.json"), "utf8"));
      rows.push({
        profile,
        std,
        variant,
        wasm_bytes: bytes.length,
        runtime_js_bytes: info.runtime_js_bytes,
        payload_formats: payloadFormats,
        passed: true,
      });
      console.log(
        `panic ${profile}/${std ? "std" : "no_std"}/${variant}: ${bytes.length} B; formatting, fatal identity and native trap passed`,
      );
    }
  }
}
const inputs = [
  "tools/check-panic.mjs",
  "Cargo.lock",
  "rust-toolchain.toml",
  "crates/taraba/Cargo.toml",
  "crates/taraba/src/lib.rs",
  "crates/taraba/src/panic.rs",
  "crates/taraba-cli/src/abi.rs",
  "crates/taraba-cli/src/build.rs",
  "crates/taraba-cli/assets/provenance.json",
];
writeFileSync(
  join(root, "check.json"),
  JSON.stringify(
    {
      measured_at: new Date().toISOString(),
      node: process.version,
      v8: process.versions.v8,
      inputs: Object.fromEntries(
        inputs.map((f) => [
          f,
          createHash("sha256").update(readFileSync(f)).digest("hex"),
        ]),
      ),
      rows,
      safari_browser_verified: false,
    },
    null,
    2,
  ) + "\n",
);
