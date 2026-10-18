import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { summary } from "../experiments/async-size/report.mjs";

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
    ...["README", "guide", "core-runtime", "development", "async-size"].flatMap(
      (name) => [`docs/${name}.md`, `docs/${name}.ja.md`],
    ),
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
