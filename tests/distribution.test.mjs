import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";

test("runtime, allocator, and native CLI are distributable crates", () => {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
      encoding: "utf8",
    }),
  );
  for (const name of ["kanimiso", "kanimiso-allocator", "kanimiso-cli"]) {
    const pkg = metadata.packages.find((p) => p.name === name);
    assert.ok(pkg, `missing ${name}`);
    assert.notDeepEqual(pkg.publish, [], `${name} must be publishable`);
    assert.equal(pkg.version, "0.1.0");
    assert.ok(pkg.license, `${name} must declare a license`);
  }
  assert.ok(!metadata.packages.some((p) => p.name === "wee-port"));
});
