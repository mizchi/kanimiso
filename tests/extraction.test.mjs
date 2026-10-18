import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, relative } from "node:path";
test("every Cargo member and source dependency is within the extracted repository", () => {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
      encoding: "utf8",
    }),
  );
  const root = resolve(".");
  for (const pkg of metadata.packages) {
    assert.ok(!relative(root, pkg.manifest_path).startsWith(".."));
    for (const dep of pkg.dependencies)
      if (dep.path) assert.ok(!relative(root, dep.path).startsWith(".."));
  }
  for (const file of [
    "crates/kanimiso/src/lib.rs",
    "examples/promise/src/lib.rs",
  ]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /#\[path\s*=/);
  }
});
