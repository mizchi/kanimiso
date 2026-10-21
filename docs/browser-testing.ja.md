# ブラウザー E2E

[English](browser-testing.md) | 日本語

実際のブラウザーで、生成した ESM と Wasm を HTTP 経由で読み込み、標準の instantiate → attach → 型付き API を検証します。

```sh
pnpm exec playwright install chrome webkit
just browser-check                      # 固定した安定版: Chrome + WebKit
just browser-check --project=webkit     # 安定版 WebKit のみ
just webkit-latest-check                # 実行時点の Playwright @next / WebKit
```

nightly は `.cache/playwright-latest/` に分離してインストールします。ルートの package.json / pnpm-lock.yaml は変更しません。毎回 `next` を解決し、対応する WebKit を取得します。同じ版を再実行する場合は版を指定します。

```sh
just webkit-latest-check 1.65.0-alpha-2026-10-21
```

## 検証すること

- 数値・文字列・record・TypedArray、memory.grow 後の値の独立性。
- Future / JSPI の実 Wasm 実行、Promise reject の identity、実際の fetch の中断。
- imported resource の constructor・method、Rust resource の状態変更・own 移譲・型/instance の一致。
- 同じ resource の並行 borrow、片方だけのキャンセル、遅延した Promise 完了、他方の借用の維持。
- 非同期 host callback を経由した再入、poll / Rust Drop 中の終了、trap 後の待機タスクの reject と destructor の再実行防止。
- Rust task export を含まない同期 resource と、host binding を渡さない初期化。
- Future / JSPI の Module Worker での ESM import・Wasm streaming instantiate・実行・終了。
- Request / Response を通す注文ミドルウェア。

各テストは未捕捉の pageerror を検出し、Playwright の版・実ブラウザーの版・OS・CPU・WebKit の実行パス・User-Agent・JSPI API の情報を添付します。未対応機能を理由に skip しません。

## 結果と再現性

2026-10-21、macOS arm64 で実行しました。

| 構成 | WebKit build | 結果 |
|---|---:|---:|
| 固定した Playwright 1.64.1、Chrome + WebKit 27.2 | 2370 | 26/26 通過 |
| Playwright 1.65.0-alpha-2026-10-21、WebKit 27.2 | 2380 | 13/13 通過 |

安定版は `.cache/browser/results.json` と `report/`、nightly は `.cache/browser/latest/` に出力します。nightly の `engine.json` は解決した版、WebKit の配布情報と実行環境、テスト・設定・生成 JS/Wasm のハッシュ、成功/失敗を記録します。HTML レポートから失敗時の trace を開けます。

```sh
pnpm exec playwright show-report .cache/browser/latest/report
```

GitHub Actions の browser job は安定版と実行時点の nightly を検査し、結果を browser-verification artifact に保存します。

[Playwright の WebKit](https://playwright.dev/docs/browsers#webkit) は WebKit main 由来のテスト用ビルドです。このプロジェクトでは Safari 向け検証の正式な代替とし、WebKit E2E の通過で Safari 27+ 対応の検証は完了です。Safari.app の追加実行は完了条件に含めません。実行記録は Playwright WebKit とし、Safari.app を実行したという意味にはしません。[nightly の説明](https://playwright.dev/docs/canary-releases)も参照してください。

`engine.json` の `safari_validation` は `method: "playwright-webkit"` と `completed` で完了状態を示します。`safari_app_verified: false` は Safari.app を実行していないという記録で、Safari 向け検証が未完了という意味ではありません。
