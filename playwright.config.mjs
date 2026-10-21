import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const root = resolve(process.env.TARABA_BROWSER_ROOT || ".");
const reportDir = resolve(
  root,
  process.env.TARABA_BROWSER_REPORT_DIR || ".cache/browser",
);
export default defineConfig({
  testDir: "tests/browser",
  timeout: 30000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(reportDir, "results.json") }],
    ["html", { outputFolder: resolve(reportDir, "report"), open: "never" }],
  ],
  outputDir: resolve(reportDir, "results"),
  webServer: {
    command: "node tools/browser-server.mjs",
    cwd: root,
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
  use: { baseURL: "http://127.0.0.1:4179", trace: "retain-on-failure" },
  projects: [
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
