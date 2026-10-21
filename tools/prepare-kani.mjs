import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
export function prepareKani(root = ".cache/kani") {
  const allocator = "crates/taraba-allocator",
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
    "crates/taraba/src/waker.rs",
    "crates/taraba/src/promise.rs",
    "crates/taraba/src/value.rs",
    "crates/taraba/src/resource.rs",
    "crates/taraba-helpers/src/regexp.rs",
    `${harnesses}/regexp.rs`,
    "crates/taraba-helpers/src/handle.rs",
    "crates/taraba-helpers/src/iter.rs",
    `${harnesses}/iterator.rs`,
    ...["allocator", "backend", "waker", "promise", "promise_state"].map(
      (n) => `${harnesses}/${n}.rs`,
    ),
  ];
  mkdirSync(`${root}/resource/src`, { recursive: true });
  copyFileSync(
    "crates/taraba/src/resource.rs",
    `${root}/resource/src/resource.rs`,
  );
  writeFileSync(
    `${root}/resource/src/lib.rs`,
    "extern crate alloc;mod resource;\n",
  );
  writeFileSync(
    `${root}/resource/Cargo.toml`,
    `[package]\nname="taraba-resource-kani"\nversion="0.0.0"\nedition="2024"\n[workspace]\n[lints.rust]\nunexpected_cfgs={level="warn",check-cfg=['cfg(kani)']}\n`,
  );
  mkdirSync(`${root}/allocator/src`, { recursive: true });
  mkdirSync(`${root}/waker/src`, { recursive: true });
  mkdirSync(`${root}/promise/src`, { recursive: true });
  mkdirSync(`${root}/regexp/src`, { recursive: true });
  mkdirSync(`${root}/iterator/src`, { recursive: true });
  for (const name of ["handle", "iter"])
    copyFileSync(
      `crates/taraba-helpers/src/${name}.rs`,
      `${root}/iterator/src/${name}.rs`,
    );
  copyFileSync(`${harnesses}/iterator.rs`, `${root}/iterator/src/lib.rs`);
  writeFileSync(
    `${root}/iterator/Cargo.toml`,
    `[package]\nname="taraba-iterator-kani"\nversion="0.0.0"\nedition="2024"\n[workspace]\n[lints.rust]\nunexpected_cfgs={level="warn",check-cfg=['cfg(kani)']}\n`,
  );
  const regexp = readFileSync("crates/taraba-helpers/src/regexp.rs", "utf8");
  const regexpPrefix = regexp.indexOf("#[cfg(not(test))]");
  assert.ok(regexpPrefix > 0);
  writeFileSync(
    `${root}/regexp/src/lib.rs`,
    regexp.slice(0, regexpPrefix) +
      readFileSync(`${harnesses}/regexp.rs`, "utf8"),
  );
  writeFileSync(
    `${root}/regexp/Cargo.toml`,
    `[package]\nname="taraba-regexp-kani"\nversion="0.0.0"\nedition="2024"\n[workspace]\n[lints.rust]\nunexpected_cfgs={level="warn",check-cfg=['cfg(kani)']}\n`,
  );
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
    `[package]\nname="taraba-allocator-kani"\nversion="0.0.0"\nedition="2021"\nlicense="MPL-2.0"\n[workspace]\n[features]\ndefault=[]\nsize_classes=[]\ninstrumentation=[]\nextra_assertions=[]\nrealloc_in_place=[]\n[dependencies]\nmemory_units="=0.4.0"\n[lints.rust]\nunexpected_cfgs={level="warn",check-cfg=['cfg(kani)']}\n`,
  );
  const original = readFileSync("crates/taraba/src/waker.rs", "utf8");
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
  writeFileSync(
    `${root}/promise/src/promise.rs`,
    readFileSync("crates/taraba/src/promise.rs", "utf8") +
      "\n" +
      readFileSync(`${harnesses}/promise_state.rs`, "utf8"),
  );
  copyFileSync("crates/taraba/src/value.rs", `${root}/promise/src/value.rs`);
  copyFileSync(`${harnesses}/promise.rs`, `${root}/promise/src/lib.rs`);
  writeFileSync(
    `${root}/promise/Cargo.toml`,
    `[package]\nname="taraba-promise-kani"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[lints.rust]\nunexpected_cfgs={level="warn",check-cfg=['cfg(kani)']}\n`,
  );
  const files = [
    "resource/Cargo.toml",
    "resource/src/lib.rs",
    "resource/src/resource.rs",
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
    "promise/Cargo.toml",
    "promise/src/lib.rs",
    "promise/src/promise.rs",
    "promise/src/value.rs",
    "regexp/Cargo.toml",
    "regexp/src/lib.rs",
    "iterator/Cargo.toml",
    "iterator/src/lib.rs",
    "iterator/src/handle.rs",
    "iterator/src/iter.rs",
  ].map((p) => join(root, p));
  const provenance = {
    root: resolve(root),
    inputs: Object.fromEntries(inputs.map((p) => [p, hash(p)])),
    generated: Object.fromEntries(files.map((p) => [p, hash(p)])),
    adaptations: [
      "Allocator lib.rs is unchanged prefix; harness appended; helper modules and MPL license copied unchanged",
      "Wasm/native test page backend is replaced by a single-agent always-OOM refill backend; harness seeds 512 bytes of real free-cell storage; no memory.grow, OS, mutex or JS proof",
      "Waker source only expands wasm32 wake import gate to cfg(kani); mock records ID/call count; clone/drop/wake/constructor bodies unchanged",
      "Promise/value production sources are copied unchanged; private completion proof appended; modeled host checks root ownership and subscription retirement for any nonzero u32 ID. Native64 only: no JS, Wasm pointer dereference, arbitrary Waker behavior or exhaustion proof",
      "Resource storage copied unchanged; verifies one live borrow survives owner removal and drops once, plus saturating generation advancement for every u16. Native64 only; not a proof of arbitrary store histories, JS leases or Wasm single-agent enforcement",
      "Kani uses its pinned native 64-bit Rust toolchain; wasm32 layout/codegen and JS execution are outside these proofs",
      "RegExp production API/Drop prefix is unchanged; its FFI modules are replaced by a single-handle host model. Any u32 handle, boolean result and one-byte ASCII UTF-8 borrow; JS regex semantics/Map/memory.grow are outside the proof",
      "Root/JsIterator copied unchanged; model host provides an empty or single-item synchronous cursor for any nonzero u32 cursor ID. Checks early Drop, exhaustion, fused next and independent item lifetime. Clone, Unicode, JS return() and string-copy bytes are outside this proof",
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
