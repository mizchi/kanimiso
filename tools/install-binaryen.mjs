import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const version = 133;
const platform = `${process.arch === "arm64" ? (process.platform === "darwin" ? "arm64" : "aarch64") : process.arch === "x64" ? "x86_64" : process.arch}-${process.platform === "darwin" ? "macos" : process.platform}`;
const checksums = {
  "arm64-macos":
    "ad66da82ac13f163e424b1643f16c6dfcccc98b5966296b43e52d3cab04f84a8",
  "x86_64-macos":
    "13a9b90be775c6389ce3d1f879cb8627bea56708ba8c122983941d53a8199b95",
  "aarch64-linux":
    "89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8",
  "x86_64-linux":
    "2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489",
};
if (!checksums[platform]) throw Error(`unsupported platform: ${platform}`);
const directory = `.cache/toolchains/binaryen-version_${version}`;
if (existsSync(`${directory}/bin/wasm-opt`)) {
  console.log("Binaryen already present");
  process.exit(0);
}
mkdirSync(".cache/downloads", { recursive: true });
mkdirSync(".cache/toolchains", { recursive: true });
const name = `binaryen-version_${version}-${platform}.tar.gz`;
const response = await fetch(
  `https://github.com/WebAssembly/binaryen/releases/download/version_${version}/${name}`,
);
if (!response.ok) throw Error(`download: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== checksums[platform])
  throw Error("checksum mismatch");
const archive = `.cache/downloads/${name}`;
writeFileSync(archive, bytes);
const result = spawnSync("tar", ["-xf", archive, "-C", ".cache/toolchains"], {
  stdio: "inherit",
});
if (result.status !== 0) throw Error("tar failed");
console.log(`Installed Binaryen ${version} (${platform})`);
