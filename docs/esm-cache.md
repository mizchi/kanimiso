# Sharing the JavaScript runtime across libraries

English | [日本語](esm-cache.ja.md)

Core/JSPI and Core/Future libraries can **share their JavaScript runtime when imports resolve to the same ESM URL**. The module code and evaluation result are shared. Each instantiate call creates its own queue, bindings, counters and fatal state.

Default npm output has each package import its own `./taraba.mjs`. Identical contents at different paths do not share an ESM cache entry across libraries. Repeated imports of the same package URL do share one entry.

## Serve a shared chunk

The checkout's `tools/shared-runtime.mjs` provides an esbuild build-time helper. It redirects explicitly selected, generated `taraba.mjs` files to one file only when their contents match. With ESM code splitting, multiple entries import one shared chunk. Different runtime contents, including JSPI/Future and debug/release variants, remain separate.

For example, check out taraba at `./taraba` and install two generated Core packages in the consuming app. Its `src/a.mjs` and `src/b.mjs` entries import the respective packages.

```js
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { sharedRuntimePlugin } from './taraba/tools/shared-runtime.mjs';

const runtimes = ['@example/a', '@example/b'].map(name =>
  fileURLToPath(new URL('taraba.mjs', import.meta.resolve(`${name}/package.json`))),
);
await build({
  entryPoints: { a: 'src/a.mjs', b: 'src/b.mjs' },
  outdir: 'public/lib',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  outExtension: { '.js': '.mjs' },
  plugins: [sharedRuntimePlugin(runtimes)],
});
```

Use this helper for generated, self-contained Core runtimes. It does not merge arbitrary JavaScript files. Application WIT wrappers and Wasm remain separate. Serve the shared chunk along with the entries, and import the same URL within one page/realm. Libraries bundled independently need resolution to a common external runtime URL instead.

## Measurement and reproduction

`just library-check` and `just package-check` independently pack the std/no_std JSPI and Future libraries, install them into one app and run this check. Package-check repeats it with output from an archived, installed CLI. Results appear under `esm_cache` in `.cache/library-check.json`.

| Two libraries with the same profile | Runtime source | JS before sharing | JS after sharing | Runtime copies |
|---|---:|---:|---:|---|
| Core/JSPI | 1,295 B | 3,086 B | 1,804 B | 2 → 1 |
| Core/Future | 3,874 B | 8,334 B | 4,462 B | 2 → 1 |

These are total JavaScript bytes in verification ESM bundles on Node.js 24 / V8 with esbuild 0.28.2. They include exports used to inspect function identity, so they are a separate measurement from the single-package distribution size table. Wasm, declarations and compression are excluded here. A real Safari browser has not been tested.

Checks establish that runtime functions are distinct before sharing and identical afterwards, and that both entries import one chunk. Both libraries pass the size comparison's common 3,507 cases before and after sharing. Checks then suspend one instance while completing the other, check independent bindings and stats, resume the suspended computation, close one instance with a fatal error and reuse the other. Future externref slots are checked for isolation too. JavaScript tests cover different profiles, debug/release variants and files not selected for sharing.

ESM caches belong to a realm. Workers have separate realms, and distinct URLs or query strings do not share an entry. Reusing compiled `WebAssembly.Module` objects, instances or memory is a separate concern. This optimization does not reduce Wasm size or per-instance state memory. Component+jco's application-specific glue is outside this Core runtime sharing check.

[Usage guide](guide.md) · [Async size comparison](async-size.md) · [Development guide](development.md)
