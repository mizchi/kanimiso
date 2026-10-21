// Resolve today's Playwright canary in isolation; stable dependencies stay locked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
const root = resolve("."),
  work = join(root, ".cache/playwright-latest"),
  out = join(root, ".cache/browser/latest");
const requested = process.argv[2] || "next";
const env = {
  ...process.env,
  TARABA_BROWSER_ROOT: root,
  TARABA_BROWSER_REPORT_DIR: out,
  TARABA_BROWSER_CHANNEL: requested,
};
const run = (bin, args) =>
  execFileSync(bin, args, { cwd: work, env, stdio: "inherit" });
mkdirSync(work, { recursive: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const report = {
  requested,
  started_at: new Date().toISOString(),
  all_passed: false,
  safari_app_verified: false,
};
try {
  const version = JSON.parse(
    execFileSync(
      "pnpm",
      ["view", `@playwright/test@${requested}`, "version", "--json"],
      { cwd: root, encoding: "utf8" },
    ),
  );
  assert.equal(typeof version, "string");
  report.playwright = version;
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify(
      {
        name: "taraba-webkit-latest-check",
        private: true,
        type: "module",
        devDependencies: { "@playwright/test": version },
      },
      null,
      2,
    ) + "\n",
  );
  // Canary packages intentionally opt out of dependency age delays, only here.
  run("pnpm", [
    "install",
    "--ignore-workspace",
    "--no-frozen-lockfile",
    "--ignore-scripts",
    "--config.minimumReleaseAge=0",
  ]);
  const require = createRequire(join(work, "package.json"));
  const testPackage = require.resolve("@playwright/test/package.json");
  const playwrightRequire = createRequire(
    createRequire(testPackage).resolve("playwright/package.json"),
  );
  const core = dirname(
    playwrightRequire.resolve("playwright-core/package.json"),
  );
  report.webkit = JSON.parse(
    readFileSync(join(core, "browsers.json")),
  ).browsers.find((b) => b.name === "webkit");
  const cli = join(dirname(testPackage), "cli.js");
  run(process.execPath, [
    cli,
    "install",
    ...(process.env.CI ? ["--with-deps"] : []),
    "webkit",
  ]);
  rmSync(join(work, "tests/browser"), { recursive: true, force: true });
  cpSync(join(root, "tests/browser"), join(work, "tests/browser"), {
    recursive: true,
  });
  cpSync(
    join(root, "playwright.config.mjs"),
    join(work, "playwright.config.mjs"),
  );
  report.inputs = Object.fromEntries(
    [
      "playwright.config.mjs",
      "tools/check-webkit-latest.mjs",
      ...readdirSync(join(root, "tests/browser"))
        .filter((f) => f.endsWith(".mjs"))
        .map((f) => `tests/browser/${f}`),
    ].map((f) => [
      f,
      createHash("sha256")
        .update(readFileSync(join(root, f)))
        .digest("hex"),
    ]),
  );
  report.fixtures = Object.fromEntries(
    ["future", "jspi", "guest", "sync", "middleware"]
      .flatMap((profile) =>
        readdirSync(join(root, ".cache/browser", profile))
          .filter((f) => /\.(js|mjs|wasm)$/.test(f))
          .map((f) => `.cache/browser/${profile}/${f}`),
      )
      .map((f) => [
        f,
        createHash("sha256")
          .update(readFileSync(join(root, f)))
          .digest("hex"),
      ]),
  );
  console.log(
    `Testing Playwright ${version}, WebKit ${report.webkit.browserVersion} revision ${report.webkit.revision}`,
  );
  run(process.execPath, [cli, "test", "--project=webkit"]);
  const results = JSON.parse(readFileSync(join(out, "results.json")));
  assert.ok(
    results.stats.expected > 0,
    "the canary suite must actually execute tests",
  );
  assert.equal(
    results.stats.skipped + results.stats.unexpected + results.stats.flaky,
    0,
  );
  const suites = [...results.suites],
    engines = new Map();
  let annotated = 0;
  while (suites.length) {
    const suite = suites.pop();
    suites.push(...(suite.suites || []));
    for (const spec of suite.specs || [])
      for (const test of spec.tests) {
        const annotation = test.annotations.find((a) => a.type === "engine");
        assert.ok(
          annotation,
          "every executed test must record its actual engine",
        );
        const engine = JSON.parse(annotation.description);
        assert.equal(engine.playwright, version);
        assert.equal(engine.browser, "webkit");
        engines.set(annotation.description, engine);
        annotated++;
      }
  }
  assert.equal(annotated, results.stats.expected);
  report.engines = [...engines.values()];
  report.tests = results.stats;
  report.all_passed = true;
} catch (error) {
  console.error(error);
  report.error = String(error);
  process.exitCode = 1;
} finally {
  report.safari_validation = {
    method: "playwright-webkit",
    completed: report.all_passed,
  };
  report.finished_at = new Date().toISOString();
  writeFileSync(
    join(out, "engine.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      playwright: report.playwright,
      webkit: report.webkit?.revision,
      all_passed: report.all_passed,
      report: join(out, "engine.json"),
    }),
  );
}
