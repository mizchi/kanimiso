import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { VERSION } from "rolldown";
test("embedded crate assets and their inputs match the recorded hashes", () => {
  const p = JSON.parse(
    readFileSync("crates/taraba-cli/assets/provenance.json"),
  );
  assert.equal(
    p.rolldown,
    VERSION,
    "embedded assets must be built with the pinned Rolldown",
  );
  const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
  for (const [f, h] of Object.entries(p.inputs))
    assert.equal(sha(f), h, `stale asset input: ${f}; run just build-host`);
  for (const [f, h] of Object.entries(p.assets))
    assert.equal(
      sha(`crates/taraba-cli/assets/${f}`),
      h,
      `stale embedded asset: ${f}`,
    );
});
