# Frontend footprint context / フロントエンドのサイズ感

These measurements provide context for the README's Why section. They are small
usage entries, not whole-package sizes or an equivalent-workload ranking between
taraba and unrelated UI, validation and routing libraries.

README の Why 章で、フロントエンドの依存として許容されるサイズ感を説明するための
参考値です。ライブラリ全体の固定サイズや、taraba と同等の処理・機能の比較ではありません。

## Reproduce / 再現

From the repository root, with Node.js 24+, pnpm and the root dependencies installed:

```sh
pnpm install --frozen-lockfile
just compare-frontend-size
# Verify without replacing the committed snapshot:
node tools/measure-frontend-size.mjs --check
```

The task installs exact package versions into `.cache/frontend-size-reference`
with lifecycle scripts disabled. React DOM's scheduler is pinned through an
override. It does not change the repository's dependencies or lockfile.
Rolldown uses the version pinned in the root lockfile.

固定バージョンを `.cache/frontend-size-reference` に取得し、lifecycle script を無効にして
計測します。リポジトリ本体の依存と lockfile は変更しません。

[frontend-size.json](frontend-size.json) records package versions, full entry
sources, production defines, target, bundler version, raw/gzip bytes and bundle
SHA-256 hashes. Default execution refreshes this snapshot; `--check` writes a
report only to `.cache/frontend-size-reference/report.json`. README values are
rounded to three decimal places in decimal kB (1 kB = 1,000 bytes).

## Conditions / 条件

- Production, browser, ES2022, ESM; tree shaking and minification with Rolldown.
- All emitted JS, including generated wrappers and retained license comments,
  is counted; no external imports may remain. One bundle per independent entry.
- Raw bytes and gzip level 9 are separate. Compare taraba's uncompressed table
  with the raw/minified column, not with gzip values.
- React core exports only `createElement` and `useState`, without a DOM renderer.
  The React DOM and Preact entries each export a function rendering a span.
- Zod's standard `zod` entry and Valibot validate the same `{ name: string }` object.
  Zod Mini is a separate API and is not measured here.
- Hono uses its default `hono` entry and one GET route, not the `hono/tiny` preset.

The script imports every generated bundle, checks React element creation,
validator acceptance/rejection, and Hono's 200/404 responses. The two rendering
functions are checked as callable exports; real DOM rendering/browser execution
is **not** verified by this measurement.

各成果物を import して、React element の生成、両 validator の正常・不正入力、
Hono の200/404応答を確認します。DOM 描画用の2成果物は関数の export を確認する範囲です。
実ブラウザーの描画検証や実行速度の測定は行っていません。

## Primary references / 公式資料

- [React DOM createRoot](https://react.dev/reference/react-dom/client/createRoot)
  describes the separate DOM renderer; React core alone does not mount an app.
- [Preact](https://preactjs.com/) describes its small DOM implementation.
- [Zod package](https://zod.dev/packages/zod) distinguishes its standard API from
  Zod Mini; different entry points retain different code.
- [Hono](https://hono.dev/docs) distinguishes its tiny preset and optional middleware.
- [Valibot introduction](https://valibot.dev/guides/introduction/) describes its
  modular API. Its advertised minimum is not the size of every schema.

Use this repository's measured snapshot for the README numbers; the projects'
advertised sizes use different entry points, versions and compression conditions.
