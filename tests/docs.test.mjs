import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { summary } from "../experiments/async-size/report.mjs";
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

test("English/Japanese usage, reference, development and comparison pages have valid local links", () => {
  const pages = [
    "README.md",
    "README.ja.md",
    "docs/error-codes.md",
    "docs/panic-reporting.md",
    "docs/wasm-size-analysis.md",
    ...[
      "README",
      "guide",
      "core-runtime",
      "development",
      "releasing",
      "async-size",
      "esm-cache",
      "insight",
      "helpers",
      "strings",
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
