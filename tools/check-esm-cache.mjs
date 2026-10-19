import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build, VERSION } from "rolldown";
import { sharedRuntimePlugin } from "./shared-runtime.mjs";
import { verifyWit } from "../tests/support/wit-contract.mjs";
import { asyncCases } from "../tests/support/async-contract.mjs";

const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};

async function connect(library, options) {
  const host = library.createHost(options);
  const { instance } = await WebAssembly.instantiate(
    library.wasm,
    host.imports,
  );
  host.attach(instance.exports);
  return host;
}

async function verifyIsolation(libraries) {
  let release,
    fail = false;
  const reason = { instance: "A" };
  const a = await connect(libraries[0], {
    bindings: {
      add: (a, b) => {
        if (fail) throw reason;
        if (!release)
          return new Promise((r) => {
            release = () => r((a + b) | 0);
          });
        return Promise.resolve((a + b) | 0);
      },
    },
  });
  const b = await connect(libraries[1], {
    bindings: { add: async (a, b) => (a + b + 10) | 0 },
  });
  const pending = a.run(10, 1);
  await flush();
  assert.equal(typeof release, "function");
  const blocked = a.stats();
  let completed = false;
  const other = b.run(20, 2).then((value) => {
    completed = true;
    return value;
  });
  await flush();
  assert.ok(completed, "another instance must finish while A is suspended");
  assert.equal(await other, 43);
  assert.deepEqual(a.stats(), blocked, "B must not change A's state");
  const bStats = b.stats();
  release();
  assert.equal(await pending, 12);
  assert.deepEqual(b.stats(), bStats, "resuming A must not change B's state");
  fail = true;
  await assert.rejects(a.run(1, 2), (e) => e === reason);
  assert.equal(a.stats().dead, true);
  assert.equal(b.stats().dead, false);
  assert.equal(await b.run(1, 2), 24);
  // The Future externref tables are also instance-local, even when slot IDs coincide.
  const first = libraries[0].runtime.createHost().imports.jsrt?.__values;
  const second = libraries[1].runtime.createHost().imports.jsrt?.__values;
  if (first) {
    assert.notEqual(first, second);
    const x = { owner: "A" },
      y = { owner: "B" };
    first.set(1, x);
    second.set(1, y);
    assert.equal(first.get(1), x);
    assert.equal(second.get(1), y);
    first.set(1, undefined);
    second.set(1, undefined);
  }
}

/** Verify two separately packed/installed Core libraries per profile in one ESM realm. */
export async function verifyEsmCache(packages, dir) {
  mkdirSync(dir);
  const cases = [];
  for (const profile of ["jspi", "future"]) {
    const pair = packages.filter((p) => p.profile === profile);
    assert.equal(pair.length, 2);
    const runtimes = pair.map((p) => join(p.installed, "runtime.mjs"));
    const sources = runtimes.map((p) => readFileSync(p));
    assert.deepEqual(sources[0], sources[1]);
    const entryPoints = {};
    for (const [i, pkg] of pair.entries()) {
      const entry = join(dir, `${profile}-${i}.mjs`);
      writeFileSync(
        entry,
        `export {createHost} from ${JSON.stringify(pkg.name)};\nexport * as runtime from ${JSON.stringify(runtimes[i])};\n`,
      );
      entryPoints[`lib-${i}`] = entry;
    }
    const original = await Promise.all(
      Object.values(entryPoints).map((p) => import(pathToFileURL(p))),
    );
    assert.notEqual(
      original[0].runtime.createHost,
      original[1].runtime.createHost,
    );
    assert.equal(original[0].runtime, await import(pathToFileURL(runtimes[0])));
    const bundles = [];
    for (const shared of [false, true]) {
      const outdir = join(dir, `${profile}-${shared ? "shared" : "separate"}`);
      const result = await build({
        input: entryPoints,
        platform: "neutral",
        transform: { target: "es2022" },
        output: {
          dir: outdir,
          format: "esm",
          minify: true,
          entryFileNames: "[name].mjs",
          chunkFileNames: "[name]-[hash].mjs",
        },
        plugins: shared ? [sharedRuntimePlugin(runtimes)] : [],
      });
      const emitted = result.output.filter((o) => o.type === "chunk");
      const inputs = [
        ...new Set(emitted.flatMap((o) => Object.keys(o.modules))),
      ].filter((p) => p.endsWith("/runtime.mjs"));
      assert.equal(inputs.length, shared ? 1 : 2);
      if (shared) {
        const chunks = emitted.filter(
          (o) =>
            !o.isEntry &&
            Object.keys(o.modules).some((p) => p.endsWith("/runtime.mjs")),
        );
        assert.equal(chunks.length, 1);
        const chunk = chunks[0].fileName;
        for (const output of emitted.filter((o) => o.isEntry)) {
          assert.ok(output.imports.includes(chunk));
        }
      }
      const libraries = await Promise.all(
        pair.map(async (p, i) => ({
          ...(await import(pathToFileURL(join(outdir, `lib-${i}.mjs`)))),
          wasm: readFileSync(join(p.installed, "app.wasm")),
        })),
      );
      assert.equal(
        libraries[0].runtime.createHost === libraries[1].runtime.createHost,
        shared,
      );
      await verifyIsolation(libraries);
      for (const library of libraries) {
        const verified = await verifyWit(async (add) => {
          const host = await connect(library, {
            bindings: { add },
          });
          return host.run;
        }, [1, 16, 128, 1024].flatMap(asyncCases));
        assert.equal(verified.tasks, 3507);
      }
      bundles.push({
        shared,
        runtime_copies: inputs.length,
        common_cases_per_library: 3507,
        // Include identity-probe exports; these are verification bundles, not the published artifacts.
        probe_bundle_js_bytes: emitted.reduce(
          (n, o) => n + Buffer.byteLength(o.code),
          0,
        ),
      });
    }
    assert.ok(
      bundles[1].probe_bundle_js_bytes < bundles[0].probe_bundle_js_bytes,
    );
    cases.push({
      profile,
      packages: pair.map((p) => p.name),
      runtime_sha256: createHash("sha256").update(sources[0]).digest("hex"),
      runtime_source_bytes: sources[0].length,
      direct_import_shared: false,
      same_url_cached: true,
      bundled_function_identity_shared: true,
      suspension_bindings_stats_and_fatal_state_isolated: true,
      externref_tables_isolated: profile === "future",
      bundles,
    });
  }
  return {
    bundler: { name: "rolldown", version: VERSION },
    same_realm: true,
    safari_browser_verified: false,
    cases,
  };
}
