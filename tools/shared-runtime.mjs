import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** Rolldown plugin for explicitly selected, self-contained CLI-generated runtime.mjs files.
 * Only byte-identical runtimes resolve to the same module; applications are never aliased.
 * @param {Iterable<string>} runtimePaths
 * @returns {import("rolldown").Plugin}
 */
export function sharedRuntimePlugin(runtimePaths) {
  const aliases = new Map();
  return {
    name: "taraba-shared-runtime",
    buildStart() {
      const contents = new Map();
      aliases.clear();
      for (const file of runtimePaths) {
        const path = realpathSync(file),
          source = readFileSync(path, "utf8");
        const canonical = contents.get(source) ?? path;
        contents.set(source, canonical);
        aliases.set(path, canonical);
      }
    },
    resolveId(source, importer) {
      if (
        !/(^|\/)runtime\.mjs$/.test(source) ||
        (!source.startsWith(".") && !isAbsolute(source)) ||
        (!isAbsolute(source) && (!importer || importer.startsWith("\0")))
      )
        return null;
      const candidate = isAbsolute(source)
        ? resolve(source)
        : resolve(dirname(importer), source);
      if (!existsSync(candidate)) return null;
      return aliases.get(realpathSync(candidate)) ?? null;
    },
  };
}
