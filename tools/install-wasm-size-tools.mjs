import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(".cache/toolchains/wasm-size-tools");
for (const [tool, version] of [
  ["twiggy", "0.8.0"],
  ["wasm-snip", "0.4.0"],
]) {
  let installed = false;
  try {
    installed =
      execFileSync(`${root}/bin/${tool}`, ["--version"], {
        encoding: "utf8",
      }).trim() === `${tool} ${version}`;
  } catch {}
  if (!installed)
    execFileSync(
      "cargo",
      ["install", "--root", root, tool, "--version", version, "--locked"],
      { stdio: "inherit" },
    );
}
