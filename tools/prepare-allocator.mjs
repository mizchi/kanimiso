import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
const revision = "8cb75b788a4720753ac6fd30f64615f575e8761e";
try {
  execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
    stdio: "pipe",
  });
} catch {
  // A shallow CI checkout does not contain the fixed pre-change reference.
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", revision], {
    stdio: "inherit",
  });
}
const dir = ".cache/allocator/baseline";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const bytes = execFileSync("git", [
  "archive",
  revision,
  "crates/taraba-allocator",
]);
writeFileSync(".cache/allocator/baseline.tar", bytes);
execFileSync("tar", ["-xf", ".cache/allocator/baseline.tar", "-C", dir]);
const manifest = `${dir}/crates/taraba-allocator/Cargo.toml`;
writeFileSync(
  manifest,
  readFileSync(manifest, "utf8").replace(
    'name = "taraba-allocator"',
    'name = "taraba-allocator-before"',
  ) + "\n[workspace]\n",
);
