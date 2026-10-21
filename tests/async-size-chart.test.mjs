import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sizeChart } from "../experiments/async-size/chart.mjs";

test("size chart uses one zero-based scale for std/no_std and separates Wasm from JS", () => {
  const report = JSON.parse(readFileSync("docs/async-size.json", "utf8"));
  // Force a different maximum to catch a fixed axis or individually scaled rows.
  const largest = report.entries.find(
    (e) => e.id === "wit-bindgen-std-taraba-async",
  );
  largest.wasm_bytes *= 5;
  largest.runtime.raw = largest.wasm_bytes + largest.js_bytes;
  const svg = sizeChart(report);
  const rows = [
    ...svg.matchAll(
      /<g id="(jspi|future-typed|bindgen|embassy|wit-bindgen)-(std|no_std)">([\s\S]*?)<\/g>/g,
    ),
  ];
  assert.equal(rows.length, 9);
  const entries = rows.map(([, backend, mode]) =>
    report.entries.find(
      (e) =>
        e.backend === backend &&
        e.mode === mode &&
        e.workload === "async" &&
        e.allocator === "taraba",
    ),
  );
  const axisMax =
    Math.ceil(Math.max(...entries.map((e) => e.runtime.raw)) / 4 / 5000) *
    5000 *
    4;
  for (const [i, [, , , row]] of rows.entries()) {
    const e = entries[i];
    const wasm = row.match(
      /<rect class="wasm" x="([\d.]+)"[^>]* width="([\d.]+)"/,
    );
    const js = row.match(/<rect class="js" x="([\d.]+)"[^>]* width="([\d.]+)"/);
    assert.ok(wasm && js);
    const scale = 330 / axisMax;
    assert.equal(Number(wasm[1]), 270);
    assert.ok(Math.abs(Number(wasm[2]) - e.wasm_bytes * scale) < 0.001);
    assert.ok(Math.abs(Number(js[2]) - e.js_bytes * scale) < 0.001);
    assert.ok(Math.abs(Number(js[1]) - (270 + e.wasm_bytes * scale)) < 0.001);
    for (const value of [e.wasm_bytes, e.js_bytes, e.runtime.raw]) {
      assert.ok(row.includes(`>${(value / 1000).toFixed(3)}</text>`));
    }
  }
  assert.doesNotMatch(svg, /Tokio|NaN|undefined/);
  assert.match(svg, /role="img" aria-labelledby="title desc"/);
});
