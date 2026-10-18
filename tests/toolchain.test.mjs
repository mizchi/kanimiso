import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rustEnvironment } from "../tools/rust-toolchain.mjs";

test("external package consumers keep the toolchain with the installed Wasm target", () => {
  const root = resolve("."),
    temp = mkdtempSync(join(tmpdir(), "kanimiso-toolchain-"));
  const base = { ...process.env };
  delete base.RUSTUP_TOOLCHAIN;
  try {
    // An external directory must not silently choose a different toolchain.
    writeFileSync(
      join(temp, "rust-toolchain.toml"),
      '[toolchain]\nchannel = "kanimiso-regression-unavailable"\n',
    );
    const expected = execFileSync("rustc", ["--version"], {
      cwd: root,
      env: base,
      encoding: "utf8",
    });
    const env = rustEnvironment(root, base);
    assert.equal(
      execFileSync("rustc", ["--version"], {
        cwd: temp,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      expected,
    );
    const libdir = execFileSync(
      "rustc",
      ["--print", "target-libdir", "--target", "wasm32-unknown-unknown"],
      { cwd: temp, env, encoding: "utf8" },
    ).trim();
    assert.match(libdir, /wasm32-unknown-unknown/);
    assert.ok(
      readdirSync(libdir).some((f) => /^libcore.*\.rlib$/.test(f)),
      "selected toolchain must have the Wasm core library installed",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
