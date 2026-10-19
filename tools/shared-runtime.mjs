import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** esbuild plugin for explicitly selected, self-contained CLI-generated taraba.mjs files.
 * Only byte-identical runtimes resolve to the same module; applications are never aliased.
 */
export function sharedRuntimePlugin(runtimePaths) {
  return {
    name: "taraba-shared-runtime",
    setup(build) {
      const contents = new Map(),
        aliases = new Map();
      for (const file of runtimePaths) {
        const path = realpathSync(file),
          source = readFileSync(path, "utf8");
        const canonical = contents.get(source) ?? path;
        contents.set(source, canonical);
        aliases.set(path, canonical);
      }
      build.onResolve({ filter: /(^|\/)taraba\.mjs$/ }, (args) => {
        if (
          args.namespace !== "file" ||
          (!args.path.startsWith(".") && !isAbsolute(args.path))
        )
          return;
        const candidate = resolve(args.resolveDir, args.path);
        if (!existsSync(candidate)) return;
        const path = aliases.get(realpathSync(candidate));
        if (path) return { path };
      });
    },
  };
}
