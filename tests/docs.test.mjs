import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { summary } from "../experiments/async-size/report.mjs";
import { sizeChart } from "../experiments/async-size/chart.mjs";
import {
  regexTable,
  auditTable,
  stringsTable,
} from "../tools/helpers-report.mjs";

test("string tables match the same-corpus size snapshot", () => {
  const report = JSON.parse(readFileSync("docs/strings-size.json"));
  assert.equal(report.all_passed, true);
  for (const lang of ["ja", "en"]) {
    const text = readFileSync(
      lang === "ja" ? "docs/strings.ja.md" : "docs/strings.md",
      "utf8",
    );
    assert.equal(
      text.match(
        /<!-- strings-size:begin -->\n([\s\S]*?)\n<!-- strings-size:end -->/,
      )[1],
      stringsTable(report, lang),
    );
  }
});

test("helper tables match the same-test size snapshot", () => {
  const report = JSON.parse(readFileSync("docs/helpers-size.json"));
  assert.equal(report.all_passed, true);
  for (const lang of ["ja", "en"]) {
    const text = readFileSync(
      lang === "ja" ? "docs/helpers.ja.md" : "docs/helpers.md",
      "utf8",
    );
    for (const [name, content] of [
      ["regex", regexTable(report, lang)],
      ["audit", auditTable(report, lang)],
    ]) {
      assert.equal(
        text.match(
          new RegExp(
            `<!-- helpers-${name}:begin -->\\n([\\s\\S]*?)\\n<!-- helpers-${name}:end -->`,
          ),
        )[1],
        content,
      );
    }
  }
});

test("both READMEs show the measured size table without snapshot drift", () => {
  const report = JSON.parse(readFileSync("docs/async-size.json", "utf8"));
  assert.equal(
    readFileSync("docs/assets/async-size.svg", "utf8"),
    sizeChart(report),
  );
  for (const lang of ["en", "ja"]) {
    const path = lang === "ja" ? "README.ja.md" : "README.md";
    const contents = readFileSync(path, "utf8");
    const block = contents.match(
      /<!-- async-size:begin -->\n([\s\S]*?)\n<!-- async-size:end -->/,
    );
    assert.ok(block, `${path}: missing comparison table`);
    assert.equal(block[1], summary(report, lang));
  }
});

test("shared-runtime tables match the verified snapshot and shipped assets", () => {
  const report = JSON.parse(readFileSync("docs/esm-cache-size.json", "utf8"));
  const rows = report.cases.map((entry) => {
    const name = entry.profile === "jspi" ? "JSPI" : "Future";
    const asset = entry.profile === "jspi" ? "taraba-jspi.mjs" : "taraba.mjs";
    const bytes = readFileSync(`crates/taraba-cli/assets/${asset}`);
    assert.equal(bytes.length, entry.runtime_source_bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.runtime_sha256,
    );
    const before = entry.bundles.find((bundle) => !bundle.shared);
    const after = entry.bundles.find((bundle) => bundle.shared);
    const size = (value) => `${value.toLocaleString("en-US")} B`;
    return `| Core/${name} | ${size(bytes.length)} | ${size(before.probe_bundle_js_bytes)} | ${size(after.probe_bundle_js_bytes)} | ${before.runtime_copies} → ${after.runtime_copies} |`;
  });
  for (const path of ["docs/esm-cache.md", "docs/esm-cache.ja.md"]) {
    const contents = readFileSync(path, "utf8");
    const block = contents.match(
      /<!-- esm-cache-size:begin -->\n([\s\S]*?)\n<!-- esm-cache-size:end -->/,
    );
    assert.ok(block, `${path}: missing measured runtime table`);
    assert.deepEqual(block[1].split("\n").slice(2), rows);
  }
});

test("English/Japanese usage, reference, development and comparison pages have valid local links", () => {
  const pages = [
    "README.md",
    "README.ja.md",
    "docs/error-codes.md",
    "docs/panic-reporting.md",
    "docs/wasm-size-analysis.md",
    "docs/engine-baseline.md",
    "docs/jspi-adoption.md",
    ...[
      "README",
      "status",
      "guide",
      "core-runtime",
      "typescript",
      "development",
      "releasing",
      "async-size",
      "esm-cache",
      "insight",
      "helpers",
      "strings",
      "rich-async-size",
      "bundle-tuning",
    ].flatMap((name) => [`docs/${name}.md`, `docs/${name}.ja.md`]),
  ];
  for (const page of pages) {
    assert.ok(existsSync(page), `missing ${page}`);
    const text = readFileSync(page, "utf8").replace(/```[\s\S]*?```/g, "");
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      assert.ok(
        existsSync(resolve(dirname(page), target)),
        `${page}: broken link to ${target}`,
      );
    }
  }
});
