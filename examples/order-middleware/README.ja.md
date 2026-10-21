# Rust の注文ミドルウェア

[English](README.md) | 日本語

Request → 注文の検証・見積もり → Response を行うライブラリです。HTTP・WHATWG URL・JSON は JS、customer/SKU の正規化・重複明細の統合・数量と価格の検査・u32 合計の検査は Rust に置きます。認可は async host import を待機します。注文の永続化は行いません。

`just setup` を済ませた checkout から実行します。

```sh
just build-order-middleware
node examples/order-middleware/demo.mjs
pnpm --dir examples/order-middleware/pkg pack
```

導入済み CLI と PATH 上の Binaryen 133 を使う場合は、この例のディレクトリで次を実行します。

```sh
taraba build --world app
node package.mjs
node demo.mjs
```

この例の Cargo path 依存は対応する checkout の crate を選びます。生成した `pkg/` を npm 配布した後の利用者には、Rust やリポジトリは不要です。

## 生成 npm の利用

```ts
import { createHost } from 'taraba-order-middleware';
import { createMiddleware } from 'taraba-order-middleware/http';

const host = createHost({ bindings: {
  authorize: async (tenant, total) => tenant === 'shop' && total <= 1_000_000,
}});
const { instance } = await WebAssembly.instantiate(bytes, host.imports);
host.attach(instance.exports);
const handle: (request: Request) => Promise<Response> = createMiddleware(host);
const response = await handle(request);
// host が不要になったら終了する。
host.dispose();
```

`bytes` と `request` はアプリが用意します。`createMiddleware` は HTTP アダプターで、Wasm の生成やロードを隠しません。ブラウザーでは fetch/instantiateStreaming、Node では公開した `taraba-order-middleware/app.wasm` を読み込めます。型定義は WIT から生成し、HTTP の型は生成 host を参照するため、ドメイン型を二重定義しません。`./http` の追加はこの例の post-build `package.mjs` で行い、taraba Core の公開 export は変更しません。

## 契約

- `POST /orders`、`application/json`（charset 指定可）、`?dry-run=0|1`、`x-tenant` ヘッダー。
- JSON は `{customer: string, items: [{sku: string, quantity: number, unitPrice: number}]}`。未知のフィールドは無視します。WIT へ渡す前に形と u32 範囲を検査します。customer の単独 UTF-16 surrogate は両バックエンドに渡す前に置換します。
- 本文は64 KiBを上限として読み、超過時は source を cancel。厳密な UTF-8 として decode します。上流から一度に大きな chunk が届く場合もあるため、上限は保持する chunk の制限であり、上流の確保量の保証ではありません。
- tenant/SKU は ASCII 英数字・ハイフン・underscore の1–32 B。前後の ASCII space/tab/CR/LF を除去し、SKU を大文字にします。customer は同じ trim 後に UTF-8 で1–80 B。
- 明細は1–128件、数量1–100、価格は整数で1–1,000,000通貨最小単位。正規化後に同じ SKU の明細は最初の出現順で統合します。価格の不一致・統合数量100超はエラー。合計は u32 の checked 演算です。件数を制限した線形探索で HashMap 依存を避けます。
- 検証成功後に認可を一度呼びます。dry-run も同様です。例の認可ポリシーはサンプルで、実際の I/O・認可ルールはアプリが注入します。
- HTTP/JSON の不正は400/404/405/413/415、ドメインの不正は422、認可拒否は403、成功は200。予期しないホスト I/O のエラーは呼び出し元やフレームワークへ伝播します。
- Request.signal と guest のキャンセルは接続していません。Core の stream ABI や resource method を追加する例ではありません。

## 比較

```sh
just compare-order-middleware
just check-order-middleware
```

[計測結果](../../docs/order-middleware.ja.md)で、同じ Rust ロジックを使う Core Future と標準 wit-bindgen/jco、独立した JS 実装を比較します。共通196ケース、Unicode・エラー・並行32を検証します。Core の std/no_std は npm pack/install 後に、別アプリで NodeNext/bundler の strict TS と実行も確認します。

HTTP 全体と guest 単体の時間、warm process の新規初期化、別ビルドで計装した Rust ヒープを記録します。実際のコピー回数・JS ヒープ・Safari.app・本番 Workers は未計測です。resource・stream・helper の追加は[ロードマップ](../../docs/roadmap.ja.md)で分けて追跡します。
