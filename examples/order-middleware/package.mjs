// Post-process the example's generated Core package; taraba's loader stays standard.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
export function packageHttp(folder) {
  const file = join(folder, "package.json"),
    pkg = JSON.parse(readFileSync(file));
  for (const name of ["http.mjs", "http.d.mts"])
    copyFileSync(join(here, name), join(folder, name));
  pkg.exports["./http"] = { types: "./http.d.mts", import: "./http.mjs" };
  pkg.files = [...new Set([...pkg.files, "http.mjs", "http.d.mts"])];
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  packageHttp(resolve(process.argv[2] ?? "pkg"));
