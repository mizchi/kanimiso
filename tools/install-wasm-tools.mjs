import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const version = "1.245.1";
const platform = `${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}-${process.platform === "darwin" ? "macos" : process.platform}`;
// Digests from bytecodealliance/wasm-tools release v1.245.1.
const checksums = {
  "aarch64-macos":
    "d69043b13f8ad4bc07c993e9630e795a7f2c2af488e5688d15044a1448dfa139",
  "x86_64-macos":
    "dd718c5c9c6044f97e2d6ee076e91f6e448c8a3b31d3c5397b16f03c461857b7",
  "aarch64-linux":
    "e01ef74b8e7b4a819d91122fdd87084fb25a938e4bfa4179cc5524b961468c85",
  "x86_64-linux":
    "b171e20fd107e63e89ef6c936b5581597666a086af677d7818de92b7cdd5a86d",
};
if (!checksums[platform]) throw Error(`unsupported platform: ${platform}`);
const directory = `.cache/toolchains/wasm-tools-${version}-${platform}`;
if (existsSync(`${directory}/wasm-tools`)) {
  console.log(`wasm-tools ${version} already present`);
  process.exit(0);
}
const name = `wasm-tools-${version}-${platform}.tar.gz`;
const response = await fetch(
  `https://github.com/bytecodealliance/wasm-tools/releases/download/v${version}/${name}`,
);
if (!response.ok) throw Error(`download: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== checksums[platform])
  throw Error("wasm-tools checksum mismatch");
mkdirSync(".cache/downloads", { recursive: true });
mkdirSync(".cache/toolchains", { recursive: true });
const archive = `.cache/downloads/${name}`;
writeFileSync(archive, bytes);
execFileSync("tar", ["-xf", archive, "-C", ".cache/toolchains"], {
  stdio: "inherit",
});
console.log(`Installed wasm-tools ${version} (${platform})`);
