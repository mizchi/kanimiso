# Browser E2E

English | [日本語](browser-testing.ja.md)

Tests load the generated ESM and Wasm over HTTP in actual browsers, using native instantiation, attach and the typed API.

```sh
pnpm exec playwright install chrome webkit
just browser-check                      # Locked stable Chrome + WebKit
just browser-check --project=webkit     # Stable WebKit only
just webkit-latest-check                # Current Playwright @next / WebKit
```

Canary is installed separately under `.cache/playwright-latest/`. Root package.json and pnpm-lock.yaml stay unchanged. Each run resolves next and installs its matching WebKit. To reproduce a specific version:

```sh
just webkit-latest-check 1.65.0-alpha-2026-10-21
```

## Coverage

- Numbers, strings, records, TypedArrays and independent returned values after memory.grow.
- Actual Future / JSPI Wasm execution, Promise rejection identity and real fetch cancellation.
- Imported constructors/methods and Rust resource state, own transfer and type/instance identity.
- Concurrent borrows of one resource, independent cancellation, late Promise completion and retention of the other borrow.
- Reentry through async host callbacks, shutdown during poll and Rust Drop, pending rejection after traps and prevention of destructor reentry into poisoned Wasm.
- Synchronous resources without Rust task exports, and initialization without host bindings.
- Future / JSPI ESM imports, Wasm streaming instantiation, execution and disposal in module Workers.
- Order middleware through Request / Response.

Every test detects uncaught page errors and attaches Playwright/browser versions, OS/CPU, the WebKit executable path, User-Agent and JSPI API diagnostics. Missing features do not cause skips.

## Results and reproduction

Executed on macOS arm64 on 2026-10-21:

| Configuration | WebKit build | Result |
|---|---:|---:|
| Locked Playwright 1.64.1, Chrome + WebKit 27.2 | 2370 | 26/26 passed |
| Playwright 1.65.0-alpha-2026-10-21, WebKit 27.2 | 2380 | 13/13 passed |

Stable results are `.cache/browser/results.json` and report/. Canary results are under `.cache/browser/latest/`. Its engine.json records the resolved version, WebKit distribution and actual execution environment, hashes of tests/configuration/generated JS/Wasm, and success or failure. The HTML report links failure traces.

```sh
pnpm exec playwright show-report .cache/browser/latest/report
```

The GitHub Actions browser job checks both stable and current canary, saving reports in the browser-verification artifact.

[Playwright WebKit](https://playwright.dev/docs/browsers#webkit) is a testing build derived from WebKit main. This project accepts it as the Safari validation substitute: passing WebKit E2E completes Safari 27+ validation, with no additional Safari.app run required. Execution records identify Playwright WebKit and do not claim that Safari.app was run. See also [canary releases](https://playwright.dev/docs/canary-releases).

In engine.json, safari_validation records method "playwright-webkit" and completed. The separate safari_app_verified: false records that Safari.app was not run; it does not mean Safari-target validation is incomplete.
