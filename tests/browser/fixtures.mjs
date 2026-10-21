import { test as base, expect } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const playwright = require("@playwright/test/package.json").version;

export const test = base.extend({
  engineEvidence: [
    async ({ page, browser, browserName }, use, info) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const engine = {
        playwright,
        channel: process.env.TARABA_BROWSER_CHANNEL || "stable",
        browser: browserName,
        version: browser.version(),
        platform: process.platform,
        arch: process.arch,
        executable:
          browserName === "webkit"
            ? browser.browserType().executablePath()
            : null,
      };
      info.annotations.push({
        type: "engine",
        description: JSON.stringify(engine),
      });
      await page.goto("/");
      Object.assign(
        engine,
        await page.evaluate(() => ({
          userAgent: navigator.userAgent,
          promising: typeof WebAssembly.promising,
          suspending: typeof WebAssembly.Suspending,
          dispose: typeof Symbol.dispose,
        })),
      );
      try {
        await use();
      } finally {
        await info.attach("browser-engine", {
          body: JSON.stringify({ ...engine, pageErrors: errors }, null, 2),
          contentType: "application/json",
        });
        expect(errors, "unexpected uncaught browser errors").toEqual([]);
      }
    },
    { auto: true },
  ],
});
export { expect };
