# 複数ライブラリで JS ランタイムを共有する

[English](esm-cache.md) | 日本語

taraba の Core/JSPI・Core/Future は、**同じ ESM URL に解決すれば JS ランタイムを共有できます**。共有するのはモジュールのコードと評価結果です。待機キュー、bindings、カウンター、fatal 状態は createHost ごとに作られます。

既定の npm 出力は、各パッケージが自分の `./runtime.mjs` を参照します。内容が同じでも別のパスなので、異なるライブラリ間では自動的には ESM キャッシュを共有しません。同じパッケージの同じ URL を再 import する場合は共有します。

## 共通チャンクとして配信する

リポジトリの `tools/shared-runtime.mjs` は Rolldown 用のビルド時ヘルパーです。明示した生成済み `runtime.mjs` の内容が一致する場合だけ、参照を一つのファイルへ集約します。ESM の code splitting と組み合わせると、複数の entry が同じ共通チャンクを import します。JSPI/Future や debug/release など、内容の異なるランタイムは集約しません。

たとえば taraba を `./taraba` に checkout し、二つの Core パッケージをインストールした利用アプリのビルドスクリプトで使います。`src/a.mjs` と `src/b.mjs` はそれぞれのパッケージを import するアプリの entry です。利用アプリに `pnpm add -D rolldown@1.2.14` でビルド依存を追加し、[Rolldown の build API](https://rolldown.rs/guide/getting-started#using-the-api) を使います。

```js
import { build } from 'rolldown';
import { fileURLToPath } from 'node:url';
import { sharedRuntimePlugin } from './taraba/tools/shared-runtime.mjs';

const runtimes = ['@example/a', '@example/b'].map(name =>
  fileURLToPath(new URL('runtime.mjs', import.meta.resolve(`${name}/package.json`))),
);
await build({
  input: { a: 'src/a.mjs', b: 'src/b.mjs' },
  platform: 'neutral',
  transform: { target: 'es2022' },
  output: {
    dir: 'public/lib',
    format: 'esm',
    minify: true,
    entryFileNames: '[name].mjs',
    chunkFileNames: '[name]-[hash].mjs',
  },
  plugins: [sharedRuntimePlugin(runtimes)],
});
```

これは生成済みの自己完結した Core ランタイム用です。任意の JS ファイルの統合には使いません。アプリの WIT wrapper と Wasm は個別のままです。共通チャンクも含めて配信し、同じページ／realm から同じ URL を読み込みます。ライブラリごとに独立して bundle する場合は、代わりに同じ外部ランタイム URL への解決を構成する必要があります。

## 実測と再現

`just library-check` と `just package-check` は、JSPI と Future それぞれの std/no_std を独立した npm パッケージとして pack し、同じ利用アプリへ install して検証します。package-check はアーカイブからインストールした CLI の出力でも再実行します。結果は `.cache/library-check.json` の `esm_cache` に保存します。

<!-- esm-cache-size:begin -->
| 同じ profile の2ライブラリ | ランタイム元ファイル | 集約前の JS | 集約後の JS | ランタイムの実体 |
|---|---:|---:|---:|---|
| Core/JSPI | 1,128 B | 2,794 B | 1,638 B | 2 → 1 |
| Core/Future | 3,585 B | 7,766 B | 4,121 B | 2 → 1 |
<!-- esm-cache-size:end -->

2026-10-21 の記録です。[検証結果とランタイムのハッシュ](esm-cache-size.json)。`just library-check` で再計測した際は、この記録と日英の表を一緒に更新します。ドキュメントのテストで同梱アセットとの一致も検査します。

Node.js 24 / V8、Rolldown 1.2.14 の検証用 ESM bundle の全 JS を計上しています。関数の同一性を検査する export も含むため、配布パッケージ単体のサイズ表とは別の測定です。Wasm・型定義・圧縮はこの表に含めません。Safari 向け検証には[WebKit E2E の方針](browser-testing.ja.md)を採用しています。

検証では、集約前はランタイム関数が別オブジェクト、集約後は同一オブジェクトであることと、二つの entry が同じチャンクを import することを確認します。集約前後の両ライブラリで、サイズ比較と共通の3,507ケースを通します。さらに片方の I/O を止めたまま他方を完了し、bindings と stats の独立、再開後の結果、片方の fatal 後も他方が動くこと、Future の externref slot の独立を検査します。異なる profile、debug/release、集約対象に指定しないファイルの分離は JS テストで確認します。

ESM キャッシュは realm ごとです。Worker は別 realm で、別 URL やクエリーによるキャッシュ分割も共有扱いにはなりません。Wasm のコンパイル済み `WebAssembly.Module`、`WebAssembly.Instance`、memory の再利用は別の話です。この集約は Wasm のサイズや各 instance の状態メモリを削減しません。Component+jco のアプリ固有 glue は、この Core ランタイム共有の対象に含めていません。

[利用ガイド](guide.ja.md) · [非同期サイズ比較](async-size.ja.md) · [開発ガイド](development.ja.md)
