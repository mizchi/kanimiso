import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
export function prepareKani(root = ".cache/kani") {
  const allocator = "crates/wee-port",
    harnesses = "verification/kani/harnesses";
  const inputs = [
    "tools/prepare-kani.mjs",
    "verification/kani/models/Cargo.toml",
    "verification/kani/models/src/lib.rs",
    `${allocator}/Cargo.toml`,
    `${allocator}/LICENSE`,
    `${allocator}/src/lib.rs`,
    `${allocator}/src/const_init.rs`,
    `${allocator}/src/extra_assert.rs`,
    `${allocator}/src/neighbors.rs`,
    `${allocator}/src/size_classes.rs`,
    `${allocator}/src/regression.rs`,
    "crates/kanimiso/src/waker.rs",
    ...["allocator", "backend", "waker"].map((n) => `${harnesses}/${n}.rs`),
  ];
  mkdirSync(`${root}/allocator/src`, { recursive: true });
  mkdirSync(`${root}/waker/src`, { recursive: true });
  const source = readFileSync(`${allocator}/src/lib.rs`, "utf8");
  // Byte-for-byte production allocator logic, with proof harnesses appended.
  writeFileSync(
    `${root}/allocator/src/lib.rs`,
    source + "\n" + readFileSync(`${harnesses}/allocator.rs`, "utf8"),
  );
  for (const name of [
    "const_init",
    "extra_assert",
    "neighbors",
    "size_classes",
    "regression",
  ])
    copyFileSync(
      `${allocator}/src/${name}.rs`,
      `${root}/allocator/src/${name}.rs`,
    );
  copyFileSync(`${harnesses}/backend.rs`, `${root}/allocator/src/imp_test.rs`);
  copyFileSync(`${allocator}/LICENSE`, `${root}/allocator/LICENSE`);
  writeFileSync(
    `${root}/allocator/Cargo.toml`,
    `[package]\nname="wee-port-kani"\nversion="0.0.0"\nedition="2021"\nlicense="MPL-2.0"\n[workspace]\n[features]\ndefault=[]\nsize_classes=[]\ninstrumentation=[]\nextra_assertions=[]\n[dependencies]\nmemory_units="=0.4.0"\n[lints.rust]\nunexpected_cfgs={level="warn",check-cfg=['cfg(kani)']}\n`,
  );
  const original = readFileSync("crates/kanimiso/src/waker.rs", "utf8");
  const needle = '#[cfg(target_arch = "wasm32")]';
  assert.equal(original.split(needle).length, 2);
  writeFileSync(
    `${root}/waker/src/waker.rs`,
    original.replace(needle, '#[cfg(any(target_arch = "wasm32", kani))]'),
  );
  copyFileSync(`${harnesses}/waker.rs`, `${root}/waker/src/lib.rs`);
  writeFileSync(
    `${root}/waker/Cargo.toml`,
    `[package]\nname="jsrt-waker-kani"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[lints.rust]\nunexpected_cfgs={level="warn",check-cfg=['cfg(kani)']}\n`,
  );
  const files = [
    "allocator/Cargo.toml",
    "allocator/LICENSE",
    ...[
      "lib",
      "const_init",
      "extra_assert",
      "neighbors",
      "size_classes",
      "regression",
      "imp_test",
    ].map((n) => `allocator/src/${n}.rs`),
    "waker/Cargo.toml",
    "waker/src/lib.rs",
    "waker/src/waker.rs",
  ].map((p) => join(root, p));
  const provenance = {
    root: resolve(root),
    inputs: Object.fromEntries(inputs.map((p) => [p, hash(p)])),
    generated: Object.fromEntries(files.map((p) => [p, hash(p)])),
    adaptations: [
      "Allocator lib.rs is unchanged prefix; harness appended; helper modules and MPL license copied unchanged",
      "Wasm/native test page backend is replaced by a single-agent always-OOM refill backend; harness seeds 512 bytes of real free-cell storage; no memory.grow, OS, mutex or JS proof",
      "Waker source only expands wasm32 wake import gate to cfg(kani); mock records ID/call count; clone/drop/wake/constructor bodies unchanged",
      "Kani uses its pinned native 64-bit Rust toolchain; wasm32 layout/codegen and JS execution are outside these proofs",
    ],
  };
  writeFileSync(
    `${root}/provenance.json`,
    JSON.stringify(provenance, null, 2) + "\n",
  );
  return provenance;
}
if (process.argv[1] === new URL(import.meta.url).pathname)
  console.log(JSON.stringify({ root: prepareKani(process.argv[2]).root }));
