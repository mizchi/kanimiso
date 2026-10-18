import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
test("embedded crate assets and their inputs match the recorded hashes", () => {
  const p = JSON.parse(
    readFileSync("crates/kanimiso-cli/assets/provenance.json"),
  );
  const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
  for (const [f, h] of Object.entries(p.inputs))
    assert.equal(sha(f), h, `stale asset input: ${f}; run just build-host`);
  for (const [f, h] of Object.entries(p.assets))
    assert.equal(
      sha(`crates/kanimiso-cli/assets/${f}`),
      h,
      `stale embedded asset: ${f}`,
    );
});
