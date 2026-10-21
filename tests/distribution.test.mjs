import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";

test("runtime, allocator, helpers, and native CLI are distributable crates", () => {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
      encoding: "utf8",
    }),
  );
  for (const name of [
    "taraba",
    "taraba-allocator",
    "taraba-helpers",
    "taraba-cli",
  ]) {
    const pkg = metadata.packages.find((p) => p.name === name);
    assert.ok(pkg, `missing ${name}`);
    assert.notDeepEqual(pkg.publish, [], `${name} must be publishable`);
    assert.equal(pkg.version, "0.2.1");
    assert.ok(pkg.license, `${name} must declare a license`);
    assert.equal(pkg.repository, "https://github.com/mizchi/taraba");
  }
  const cli = metadata.packages.find((p) => p.name === "taraba-cli");
  assert.deepEqual(
    cli.targets.filter((t) => t.kind.includes("bin")).map((t) => t.name),
    ["taraba"],
  );
  assert.ok(!metadata.packages.some((p) => p.name === "wee-port"));
});
