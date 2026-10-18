# ライブラリ利用ガイド

[English](guide.md) | 日本語

**WIT を契約として Rust/Wasm ライブラリを作り、Component または型定義付き npm パッケージとして配布するためのツールキット**です。async 関数に対応し、軽量な JSPI 構成と既存の Rust Future ランタイムも選択できます。旧名は `kanimiso` です。

## 用途ごとの選び方

| 用途 | 実行方式 | 配布形式 | 書くもの・得られるもの |
|---|---|---|---|
| async 対応 Component host 向けのライブラリ | `--component` | npm 指定なし | WIT `async func` と Rust `async fn`。Canonical ABI の `app.component.wasm` |
| async・ドメインモデルに型のある npm ライブラリ | `--component` | `--npm-name @scope/library` | 公式 wit-bindgen と jco による JS/TS。record / string / list / result と型付き async 戻り値 |
| 数値 API を持つ省サイズな JS ライブラリ | 既定 / `--jspi` | `--npm-name @scope/library` | Rust は同期形。Promise 待機は JSPI が担当。WIT から `Promise<number>` などの TS 型を生成 |
| Rust Future の並行タスク・spawn_local・明示的キャンセル | `--future` | 必要なら `--npm-name` | 既存の Core Promise/resource ランタイム。opaque resource の中身は TS では `unknown` |

**WIT から async を含むアプリ用ライブラリを作る場合は Component を選びます。** サイズを優先し、s32 / u32 / f64 の境界で足りるなら Core/JSPI を選びます。CLI の既定値は引き続き Core/JSPI です。`new` と `build` で同じ実行方式を指定してください。

`--component` は標準の Component Model / Canonical ABI を使います。二つの Core 構成は JS 向けの独自 ABI で、成果物の契約は異なります。npm 化は実行方式とは別の選択肢です。

## 生成するファイルと編集サイクル

| 場所 | 役割 |
|---|---|
| `wit/app.wit` | 公開 API。型・import/export・async の契約を変更する |
| `src/lib.rs` | 生成された Guest を実装する。業務ロジックは通常の Rust module へ分離できる |
| `Cargo.toml` | std/no_std、allocator、依存、release 設定 |
| `.cargo/config.toml` | 雛形の stack 64 KiB / memory 上限 1 MiB。アプリに合わせて調整する |
| `justfile` | 選んだ実行方式を固定した build / npm タスク |
| `pkg/` | 生成物。API の変更は WIT と Rust に加え、ここは再生成する |

WIT を変更 → Rust の型エラーに従って Guest/import を更新 → cargo build → taraba build → 利用側の tsc と実行テスト、の順に確認します。std と no_std で契約は同じでも、panic/allocator を含む配布サイズは変わります。

雛形の `just build` は選択した成果物をビルドし、`just npm @example/orders 0.1.0 MIT` は npm 用に再生成します。後者はローカルの node_modules/.bin も PATH に追加するため、jco は `pnpm add -D` で用意できます。

## インストール

`taraba-cli`、`taraba`、`taraba-allocator` の初回 crates.io 公開を準備しています。レジストリ公開・レジストリからのインストールはまだ実施していません。以下は公開後の利用手順で、現在は .crate アーカイブとリポジトリ外の利用アプリで検証しています。

```sh
rustup target add wasm32-unknown-unknown
cargo install taraba-cli --version 0.1.0 --locked
# Binaryen 133 をインストールし、各ツールを PATH に配置する
# --binaryen /path/to/bin または TARABA_BINARYEN でも指定可能
```

Component ビルドには `wasm-tools 1.245.1`、Component の **npm ビルド**にはさらに Node.js 24+ と `@bytecodealliance/jco@1.39.0` が必要です。jco のパスは `--jco /path/to/jco` で指定します。Core 用 JS は CLI に内包し、Core の生成には Node / jco は不要です。利用者によるこのリポジトリの checkout や esbuild での生成は必要ありません。

## WIT から async Component を作る

```sh
taraba new orders --component --no-std
cd orders
```

公開契約は、生成される `wit/app.wit` です。

```wit
package taraba:app@0.1.0;
world app {
  import add: async func(a: s32, b: s32) -> s32;
  export run: async func(a: s32, b: s32) -> s32;
}
```

Rust の型・import・Guest trait は公式 `wit-bindgen` が生成します。利用者はハンドル変換やランタイム ABI の export を書きません。

```rust
wit_bindgen::generate!({ path: "wit", world: "app" });

struct App;
impl Guest for App {
    async fn run(a: i32, b: i32) -> i32 {
        let first = add(a, b).await;
        add(first, 1).await
    }
}
export!(App);
```

雛形には allocator、no_std の panic handler、async binding の feature、release 設定を含みます。std 版は `--no-std` を省きます。WIT と実装を編集し、ビルドします。

```sh
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/orders.wasm \
  --wit wit --component --out-dir pkg
# 生成された justfile から: just build
```

`pkg/app.component.wasm` を最適化・Component 化・validate し、選択した WIT world との適合も検査します。`app.wit` は生成された Component の契約、`build.json` は ABI 情報です。複数の world は `--world` で選択します。Canonical ABI のメタデータを保ち、Core 用の externref lowering は適用しません。

ドメイン契約には WIT の record / list / string / result を使えます。interface や resource の所有権も標準ツールが生成します。native async の実行にはその proposal に対応した Component host が必要です。今回のライブラリ検証は validate と jco 出力の実行であり、全 native host での動作確認ではありません。WASI 実装や Preview 1 adapter は自動で付与しません。宣言した import はホスト側から提供します。

## TypeScript 型定義込みの npm ライブラリ

上の Component プロジェクトから次を実行します。

```sh
pnpm add -D @bytecodealliance/jco@1.39.0
taraba build target/wasm32-unknown-unknown/release/orders.wasm \
  --wit wit --component --jco node_modules/.bin/jco \
  --npm-name @example/orders --npm-version 0.1.0 --license MIT --out-dir pkg
cd pkg
pnpm pack
```

ESM exports、`types` 条件、配布ファイルの明示的な `files` 一覧を持つ `package.json` と、実行に必要な JS / Wasm / 型定義を生成します。jco が WIT からアプリ固有の型、`Promise<T>`、ドメイン型を生成します。元の Component は `@example/orders/component.wasm`、その WIT は `@example/orders/wit` からも参照できます。jco / wasm-tools / taraba はビルド時のツールで、生成パッケージの実行時依存には入りません。ビルド処理は publish を行いません。`--license` の既定値は `UNLICENSED` で、配布時にはアプリのライセンスを指定します。

Node の利用側では tarball（公開後はパッケージ）をインストールし、import と core module loader を渡します。

```js
import { readFile } from 'node:fs/promises';
import { instantiate } from '@example/orders';

const base = new URL(import.meta.resolve('@example/orders/package.json'));
const api = await instantiate(
  async name => WebAssembly.compile(await readFile(new URL(name, base))),
  { add: { default: async (a, b) => (a + b) | 0 } },
);
console.log(await api.run(20, 21)); // 42。型は Promise<number>
```

ブラウザーでは生成された各 core `.wasm` を fetch する loader を渡します。全 core ファイルを配信してください。動的な loader のパスを bundler が自動収集するとは限りません。Instantiation mode により host import を明示し、複数 instance を作れます。[jco の契約](https://bytecodealliance.github.io/jco/transpiling.html)を参照してください。

## ドメインモデルと型付き async

上の Component 雛形で WIT を置き換える例です。interface 名と version も公開契約に含めます。

```wit
package example:orders@0.1.0;
interface domain {
  record order { id: u32, label: string, amounts: list<u32> }
  evaluate: async func(order: order) -> result<order, string>;
}
world app {
  import domain;
  use domain.{order};
  export process: async func(order: order) -> result<order, string>;
}
```

allocator と panic handler は雛形に残し、binding と実装を更新します。

```rust
extern crate alloc;
wit_bindgen::generate!({ path: "wit", world: "app" });
struct App;
impl Guest for App {
    async fn process(order: Order) -> Result<Order, alloc::string::String> {
        example::orders::domain::evaluate(order).await
    }
}
export!(App);
```

npm 化した出力の型を使う利用側の TypeScript です。load は直前の Node の core module loader と同じものを渡します。

```ts
import { instantiate, type ImportObject } from '@example/orders';

const imports: ImportObject = {
  'example:orders/domain@0.1.0': {
    evaluate: async order => ({ ...order, label: order.label + ' ✓' }),
  },
};
const api = await instantiate(load, imports);
const order = await api.process({
  id: 4294967295,
  label: '注文 🍣',
  amounts: new Uint32Array([1, 2]),
});
const label: string = order.label;
```

公式 jco の ImportObject は version 付き interface ID を要求します。CLI の npm entry は、jco 1.39 の実行時の省略 alias に変換するため、生成された型の ID をそのまま渡せます。`list<u32>` は number[] ではなく Uint32Array、WIT のトップレベル result は JS では正常値または reject（ComponentError の payload）として扱います。アプリの型付き Err を返した後も instance を利用できることをテストしています。これは Core/JSPI の first-fatal と異なる契約です。

この record/string/list/result の往復は `just library-check` の std/no_std で検証します。[サイズ比較](async-size.ja.md)の二段 await は数値専用で、このドメインモデルと同じ workload だとは扱いません。

## 数値 API に絞った軽量 npm ライブラリ

```sh
taraba new tiny --no-std
cd tiny
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/tiny.wasm --wit wit \
  --npm-name @example/tiny --npm-version 0.1.0 --license MIT
```

```js
import { readFile } from 'node:fs/promises';
import { instantiate } from '@example/tiny';

const host = await instantiate(
  await readFile(new URL(import.meta.resolve('@example/tiny/app.wasm'))),
  { bindings: { add: async (a, b) => (a + b) | 0 } },
);
console.log(await host.exports.run(20, 21)); // 型は Promise<number>
```

Core では WIT から `AppBindings`、`AppExports`、`AppHost` を生成し、関数名と引数を TypeScript で検査します。`--npm-name` を省いたビルドは従来の `taraba.mjs` / `taraba.d.mts` を出力します。どちらも `--debug` で説明付きエラーを選べ、release では短いコードと外部辞書に分離します。

Core/JSPI は I/O 待ちも含めて instance ごとに直列化します。host reject / trap は instance を閉じ、キャンセルやその経路での Rust Drop は保証しません。任意の Rust Future や native WIT async を駆動する executor ではありません。既存 executor の独立タスク進行・キャンセルが必要なら `--future` を選びます。こちらの WIT Promise resource には中身の型がないため、TS も正確に `Promise<unknown>` とします。WIT から async 戻り値まで型を付ける場合は Component を使います。[Core ランタイムの詳細](core-runtime.ja.md)に所有権・task 上限・エラー契約を分離しています。

## サイズ・互換性・検証

JavaScript の async 実行環境は Safari 27+ / JSPI 対応 V8 を前提とします。Safari 27 実ブラウザーは未検証です。Component async / jco は upstream でも実験扱いです。その scheduler・所有権・キャンセルの契約は Component toolchain のもので、Core Future の契約とは区別します。

現在の scalar async 比較は [taraba / Embassy / wasm-bindgen](async-size.ja.md)です。過去のスナップショットは [WIT / Core / Component](wit-comparison.md)、[並行 JSPI](jspi-concurrent.md)に分けています。これらは測定時点の値で、すべての npm 出力のサイズではありません。npm の `build.json` には JS、型定義、配布する Wasm のサイズを分けて記録します。Component container も配布に含めるため、tarball 全体と実際の実行時ダウンロード量は異なります。

JSPI Future adapter と stack snapshot による並行 JSPI は `experiments/` に残し、ライブラリの通常ビルドには組み込みません。[採用条件](jspi-adoption.md)を参照してください。

検証コマンドと検証範囲は[開発ガイド](development.ja.md)にまとめています。

runtime / CLI / JS は MIT、任意で使う `taraba-allocator` は wee_alloc 由来の MPL-2.0 です。配布時も allocator のライセンスとソースに関する条件を維持してください。[THIRD_PARTY.md](../THIRD_PARTY.md)。
