import esbuild from "esbuild";
import { fileURLToPath } from "node:url";

// Trailing underscore is reserved for properties private to this single bundle.
// Never mark WIT imports, public API/diagnostics or builtin properties this way.
export const privateProperties = /_$/;

export async function bundleHost({ mangle = true, debug = false } = {}) {
  const result = await esbuild.build({
    entryPoints: [fileURLToPath(new URL("./host.mjs", import.meta.url))],
    bundle: true,
    minify: true,
    ...(mangle ? { mangleProps: privateProperties, mangleCache: {} } : {}),
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    define: { __JF_DEBUG__: String(debug) },
  });
  return {
    bytes: result.outputFiles[0].contents,
    mangleCache: result.mangleCache,
  };
}
