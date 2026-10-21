import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 30000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["json", { outputFile: ".cache/browser/results.json" }]],
  outputDir: ".cache/browser/results",
  webServer: {
    command: "node tools/browser-server.mjs",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
  use: { baseURL: "http://127.0.0.1:4179", trace: "retain-on-failure" },
  projects: [
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
