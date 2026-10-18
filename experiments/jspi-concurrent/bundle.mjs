import esbuild from "esbuild";
import { fileURLToPath } from "node:url";

export async function bundleDirectHost({ debug = false } = {}) {
  return (
    await esbuild.build({
      entryPoints: [fileURLToPath(new URL("./host.mjs", import.meta.url))],
      bundle: true,
      minify: true,
      mangleProps: /_$/,
      format: "esm",
      write: false,
      platform: "neutral",
      target: "es2022",
      define: { __JSC_DEBUG__: String(debug) },
    })
  ).outputFiles[0].contents;
}
