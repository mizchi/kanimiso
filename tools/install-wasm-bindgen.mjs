import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const version = "0.2.129";
const platform = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : process.arch === "arm64" ? "unknown-linux-gnu" : "unknown-linux-musl"}`;
const checksums = {
  "aarch64-apple-darwin":
    "81d4a23d56b3c3eb8187658329116d50e0b228a93b343825fb71f70179051cd1",
  "x86_64-apple-darwin":
    "7e028879a68ec53dae14048b55cc5215f6df75b17a9c1426fac8fa086d3202fd",
  "aarch64-unknown-linux-gnu":
    "1797c349a0f45d30946e8986b184135e12839ab576c9a04203e85febfc5dcb35",
  "x86_64-unknown-linux-musl":
    "82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e",
};
if (
  !checksums[platform] ||
  !["darwin", "linux"].includes(process.platform) ||
  !["arm64", "x64"].includes(process.arch)
)
  throw Error("unsupported wasm-bindgen platform");
const directory = `.cache/toolchains/wasm-bindgen-${version}-${platform}`;
if (existsSync(`${directory}/wasm-bindgen`)) {
  console.log("wasm-bindgen already present");
  process.exit(0);
}
const name = `wasm-bindgen-${version}-${platform}.tar.gz`;
const response = await fetch(
  `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${name}`,
);
if (!response.ok) throw Error(`download: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== checksums[platform])
  throw Error("wasm-bindgen checksum mismatch");
mkdirSync(".cache/downloads", { recursive: true });
mkdirSync(".cache/toolchains", { recursive: true });
const archive = `.cache/downloads/${name}`;
writeFileSync(archive, bytes);
execFileSync("tar", ["-xf", archive, "-C", ".cache/toolchains"], {
  stdio: "inherit",
});
console.log(`Installed wasm-bindgen ${version} (${platform})`);
