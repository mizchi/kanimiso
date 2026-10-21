import assert from "node:assert/strict";
import test from "node:test";
import {
  account,
  growth,
  verifyTypedSizeBudget,
} from "../experiments/async-size/metrics.mjs";
import { readFileSync } from "node:fs";
import { render, summary } from "../experiments/async-size/report.mjs";
import { backends, profiles } from "../experiments/async-size/backends.mjs";
import * as contract from "../experiments/async-size/contract.mjs";

test("support matrix keeps std-only executors out of no_std comparisons", () => {
  for (const backend of ["embassy", "tokio", "async-executor", "async-std"]) {
    assert.deepEqual(backends.find((b) => b.id === backend).modes, ["std"]);
    assert.ok(profiles.some((p) => p.backend === backend && p.mode === "std"));
    assert.ok(
      !profiles.some((p) => p.backend === backend && p.mode === "no_std"),
    );
  }
  assert.ok(
    profiles.some(
      (p) => p.backend === "futures-unordered" && p.mode === "no_std",
    ),
  );
  const keys = profiles.map((p) => `${p.backend}/${p.mode}/${p.allocator}`);
  assert.equal(new Set(keys).size, keys.length);
});

const promiseFactory = async (add) => async (a, b) => {
  const first = await add(a, b);
  return add(first, 1);
};
test("wit-bindgen async and async-spawn controls share Component transport with distinct Cargo features", () => {
  const minimal = backends.find((b) => b.id === "wit-bindgen");
  const spawn = backends.find((b) => b.id === "component");
  assert.equal(minimal.component, true);
  assert.equal(spawn.component, true);
  assert.deepEqual(minimal.cargo_features, ["component"]);
  assert.deepEqual(spawn.cargo_features, ["component-spawn"]);
  for (const mode of ["std", "no_std"]) {
    assert.ok(
      profiles.some((p) => p.backend === "wit-bindgen" && p.mode === mode),
    );
  }
});
test("Promise verifier checks rejection identity and subsequent executor reuse", async () => {
  assert.deepEqual(await contract.verifyPromiseFailures(promiseFactory), {
    rejected_awaits: 2,
    identity_preserved: true,
    concurrent_successes: 2,
    reusable: true,
  });
  await assert.rejects(
    contract.verifyPromiseFailures(async (add) => {
      const run = await promiseFactory(add);
      return (...args) => run(...args).catch(() => -1);
    }),
  );
  await assert.rejects(
    contract.verifyPromiseFailures(async (add) => {
      const run = await promiseFactory(add);
      return (...args) =>
        run(...args).catch(() => Promise.reject("replacement"));
    }),
  );
});

const file = (path, raw) => ({
  path,
  sizes: { raw, gzip: raw / 2, brotli: raw / 4 },
});
test("size accounting separates the Component container, declarations, and every runtime file", () => {
  const measured = account({
    runtime: [
      file("app.mjs", 100),
      file("snippets/io.js", 20),
      file("app.core.wasm", 40),
    ],
    declarations: [file("app.d.ts", 16)],
    container: file("app.component.wasm", 80),
  });
  assert.equal(measured.runtime.raw, 160);
  assert.equal(measured.runtime.gzip, 80);
  assert.equal(measured.wasm_bytes, 40);
  assert.equal(measured.js_bytes, 120);
  assert.equal(measured.declaration_bytes, 16);
  assert.equal(measured.component_bytes, 80);
  assert.equal(measured.payload_bytes, 256);
});
test("containers cannot be counted again among runtime files", () => {
  assert.throws(() =>
    account({
      runtime: [file("app.component.wasm", 80)],
      declarations: [],
      container: file("app.component.wasm", 80),
    }),
  );
});
test("async growth uses its own synchronous baseline, including JS changes", () => {
  const base = account({
    runtime: [file("a.wasm", 40), file("a.mjs", 100)],
    declarations: [],
  });
  const async = account({
    runtime: [file("a.wasm", 60), file("a.mjs", 160)],
    declarations: [],
  });
  assert.deepEqual(growth(base, async), {
    wasm_bytes: 20,
    js_bytes: 60,
    runtime_bytes: 80,
  });
});

test("typed Core bindings add no Wasm or JavaScript bytes in either Rust mode", () => {
  const entries = ["std", "no_std"].flatMap((mode) =>
    ["future", "future-typed"].map((backend) => ({
      backend,
      mode,
      allocator: "taraba",
      workload: "async",
      wasm_bytes: 2000,
      js_bytes: 3600,
    })),
  );
  assert.deepEqual(verifyTypedSizeBudget(entries), [
    { mode: "std", wasm_bytes: 0, js_bytes: 0 },
    { mode: "no_std", wasm_bytes: 0, js_bytes: 0 },
  ]);
  for (const mode of ["std", "no_std"])
    for (const metric of ["wasm_bytes", "js_bytes"]) {
      const changed = structuredClone(entries);
      changed.find((e) => e.backend === "future-typed" && e.mode === mode)[
        metric
      ]++;
      assert.throws(() => verifyTypedSizeBudget(changed), /increased/);
    }
  assert.throws(
    () => verifyTypedSizeBudget(entries.filter((e) => e.mode !== "std")),
    /missing/,
  );
});
test("reports include added schedulers and derive artifact counts from measured entries", () => {
  const r = JSON.parse(readFileSync("docs/async-size.json", "utf8"));
  // Use existing verified rows as data fixtures, with distinct backend IDs.
  r.entries = r.entries.filter(
    (e) =>
      !["tokio", "async-executor", "async-std", "futures-unordered"].includes(
        e.backend,
      ),
  );
  for (const backend of [
    "tokio",
    "async-executor",
    "async-std",
    "futures-unordered",
  ])
    for (const mode of backend === "futures-unordered"
      ? ["std", "no_std"]
      : ["std"])
      for (const workload of ["sync", "async"])
        r.entries.push({
          ...r.entries.find(
            (e) =>
              e.backend === "bindgen" &&
              e.allocator === "taraba" &&
              e.mode === mode &&
              e.workload === workload,
          ),
          backend,
          id: `${backend}-${mode}-taraba-${workload}`,
        });
  const tokio = r.entries.find(
    (e) => e.backend === "tokio" && e.workload === "async",
  );
  tokio.wasm_bytes += 100;
  tokio.js_bytes += 10;
  tokio.runtime = { ...tokio.runtime, raw: tokio.runtime.raw + 110 };
  for (const lang of ["en", "ja"]) {
    const full = render(r, lang);
    for (const name of [
      "Tokio",
      "async-executor",
      "async-std",
      "FuturesUnordered",
    ]) {
      assert.ok(full.includes(name), `${lang}: full report omits ${name}`);
    }
    assert.ok(full.includes(String(r.entries.length)));
    assert.ok(
      full.includes(
        "| Tokio current-thread + LocalSet | std | +100 | +10 | +110 |",
      ),
    );
    assert.doesNotMatch(
      full,
      /全24成果物|All 24 artifacts|async 12成果物|All 12 async artifacts/,
    );
  }
});

test("README comparison selects measured taraba, wasm-bindgen, Embassy and wit-bindgen configurations", () => {
  const r = JSON.parse(readFileSync("docs/async-size.json", "utf8"));
  const selected = r.entries.filter(
    (e) =>
      ["jspi", "future-typed", "bindgen", "embassy", "wit-bindgen"].includes(
        e.backend,
      ) &&
      e.workload === "async" &&
      e.allocator === "taraba",
  );
  assert.equal(selected.length, 9);
  // Distinguish the selected measurement from its sync and wee_alloc controls.
  const embassy = selected.find((e) => e.backend === "embassy");
  embassy.wasm_bytes = 12000;
  embassy.js_bytes = 3456;
  embassy.runtime.raw = 15456;
  for (const lang of ["en", "ja"]) {
    const text = summary(r, lang);
    for (const entry of selected) {
      const values = [entry.wasm_bytes, entry.js_bytes, entry.runtime.raw].map(
        (v) => (v / 1000).toFixed(3),
      );
      assert.ok(
        text.includes(
          `| ${entry.mode} | ${values[0]} | ${values[1]} | **${values[2]}** |`,
        ),
        `${lang}: missing ${entry.id}`,
      );
    }
    assert.doesNotMatch(
      text,
      /async-spawn \+ jco|Tokio|async-executor|async-std|FuturesUnordered/,
    );
    assert.equal(
      text
        .split("\n")
        .filter((line) =>
          /^\| (taraba|wasm-bindgen|Embassy|wit-bindgen)/.test(line),
        ).length,
      9,
    );
  }
});
