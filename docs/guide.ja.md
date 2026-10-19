# ライブラリ利用ガイド

[English](guide.md) | 日本語

**WIT を契約として Rust/Wasm ライブラリを作り、Component または型定義付き npm パッケージとして配布するためのツールキット**です。async 関数に対応し、軽量な JSPI 構成と既存の Rust Future ランタイムも選択できます。旧名は `kanimiso` です。

## 用途ごとの選び方

| 用途 | 実行方式 | 配布形式 | 書くもの・得られるもの |
|---|---|---|---|
| async 対応 Component host 向けのライブラリ | `--component` | npm 指定なし | WIT `async func` と Rust `async fn`。Canonical ABI の `app.component.wasm` |
| async・ドメインモデルに型のある npm ライブラリ | `--component` | `--npm-name @scope/library` | 公式 wit-bindgen と jco による JS/TS。record / string / list / result と型付き async 戻り値 |
| 数値 API を持つ省サイズな JS ライブラリ | 既定 / `--jspi` | 既定で npm 形式 | Rust は同期形。Promise 待機は JSPI が担当。WIT から `Promise<number>` などの TS 型を生成 |
| Rust Future の並行タスク・spawn_local・明示的キャンセル | `--future` | 既定で npm 形式 | 既存の Core Promise/resource ランタイム。opaque resource の中身は TS では `unknown` |

**WIT から async を含むアプリ用ライブラリを作る場合は Component を選びます。** サイズを優先し、s32 / u32 / f64 の境界で足りるなら Core/JSPI を選びます。`taraba new` の既定は JSPI 用の雛形です。`taraba build` は生成 Wasm の jsrt/pool import・rt_poll/rt_drop/rt_settle export と WIT resource から Core の JSPI/Future を自動選択します。必要に応じて WIT の resource drop import も確認します。Rust ソースのキーワードでは判定しません。`--jspi` / `--future` で強制指定でき、Component 出力は `--component` を明示します。

`--component` は標準の Component Model / Canonical ABI を使います。二つの Core 構成は JS 向けの独自 ABI で、成果物の契約は異なります。npm 化は実行方式とは別の選択肢です。

## 生成するファイルと編集サイクル

| 場所 | 役割 |
|---|---|
| `wit/app.wit` | 公開 API。型・import/export・async の契約を変更する |
| `src/lib.rs` | 生成された Guest を実装する。業務ロジックは通常の Rust module へ分離できる |
| `Cargo.toml` | std/no_std、allocator、依存、release 設定 |
| `.cargo/config.toml` | 雛形の stack 64 KiB / memory 上限 1 MiB。アプリに合わせて調整する |
| `justfile` | 任意で使える、選んだ実行方式の build / npm タスク |
| `pkg/` | 生成物。API の変更は WIT と Rust に加え、ここは再生成する |

WIT を変更 → Rust の型エラーに従って Guest/import を更新 → taraba build → 利用側の tsc と実行テスト、の順に確認します。std と no_std で契約は同じでも、panic/allocator を含む配布サイズは変わります。

Cargo プロジェクト内で `taraba build` を実行します。CLI が Cargo の release / wasm32-unknown-unknown ビルドと成果物生成を行います。既定は `Cargo.toml`、選んだ package の `wit/`、出力先 `pkg/` です。Cargo の JSON 出力から実際の Wasm を取得するため、target directory や lib 名を指定する必要はありません。Core は既定で `index.js`・`index.d.ts`・`package.json` を持つ npm 形式を生成します。`--npm-name` はパッケージ名の上書きです。Component の npm 出力に使う jco は `pnpm add -D` で用意し、`--jco node_modules/.bin/jco` で指定できます。

出力先は生成物専用です。単発の `taraba build` も、生成に成功してから出力先を置き換えます。失敗時は非ゼロで終了し、前回の正常な成果物を保持します。

## 生成する npm パッケージ

Core の `taraba build` は、既定で次のファイルを `pkg/` に揃えます。`--npm-name` は不要です。

| ファイル | 役割 |
|---|---|
| `index.js` | アプリ固有の `createHost` と型付きメソッドの入口 |
| `index.d.ts` | WIT 由来の `AppBindings` / `AppExports` / `AppHost` |
| `app.wasm` | 最適化した Wasm。`package-name/app.wasm` から参照可能 |
| `runtime.mjs` / `runtime.d.mts` | JS ランタイムと型定義 |
| `package.json` | `type: module`、`main` / `module`、`types`、`exports`、配布する `files` |
| `wit/` | 公開 WIT と解決した WIT 依存 |
| `helpers-*.mjs` | ヘルパーを使う時だけ生成 |
| `LICENSE.taraba` / `build.json` | taraba のライセンスとビルド・サイズの記録 |

package.json の `main` / `module` は `./index.js`、`types` と exports の types 条件は `./index.d.ts` を指します。以前の `taraba.mjs` への別名エントリーは生成しません。

| npm の項目 | Cargo プロジェクトでの既定値 | 上書き |
|---|---|---|
| `name` | 選んだ package の名前を小文字化 | `--npm-name @scope/library` |
| `version` | package の version | `--npm-version 1.2.3` |
| `license` | package の license。未指定なら `UNLICENSED` | `--license MIT` |

workspace では `--package` で選んだ package の情報を使い、`[lib].name` は npm 名に影響しません。Cargo の workspace 継承にも対応し、watch では metadata の変更も次の生成に反映します。既存の Wasm を直接指定する場合はファイル名の stem を小文字化し、版は `0.1.0`、ライセンスは `UNLICENSED` を既定値にします。

```sh
taraba build
cd pkg
pnpm pack
# npm に公開する場合
pnpm publish --access public
```

出力には JS・Wasm・型定義が揃うため、公開後の利用者に taraba CLI、Cargo、jco は不要です。解析用の `.taraba/` は npm の配布ファイルから除外します。ビルドをやり直すと出力を置き換えるので、名前・版・ライセンスの変更は Cargo.toml または CLI オプションへ反映します。

`--component` 単体は引き続き標準 Component を生成します。Component を npm 形式で配布する時は `--npm-name` と jco を指定し、入口を同じ `index.js` / `index.d.ts` に揃えます。WIT native async の API は jco の契約に従います。

## 生成アセットの更新

ランタイムのアセットは、導入済み CLI に同梱された版を使います。
CLI を更新してから、ライブラリの生成元プロジェクトで再生成します。

```sh
cargo install taraba-cli --locked --force
taraba update --check
taraba update
```

`--check` は記録済みの CLI バージョン・埋め込みアセットのハッシュを導入済み CLI と比較し、
異なれば非ゼロで終了します。ビルドやネットワークアクセスは行いません。
crates.io の新しい CLI や、Rust/WIT ソースの変更を調べるコマンドではありません。

`taraba update` は前回成功したビルドの package・feature・WIT/world・実行方式・
debug/insight・ツールのパス・npm の上書き設定を再利用します。
Cargo 入力なら Rust から再ビルドし、raw Wasm 入力なら元の Wasm から生成し直します。
Wasm・JS・TS を一緒に一時ディレクトリへ生成し、成功した時だけ出力を置き換えます。
watch の記録も一度だけ再生し、監視は起動しません。
出力先を変更していた場合は `--out-dir path` で選びます。生成 justfile の `just update` も同じコマンドです。

ビルド条件は `pkg/.taraba/rebuild.json` に記録し、解析データと同様に npm tarball から除外します。
ここにはローカルのソースパスも含まれます。記録がない旧出力やプロジェクトの移動後は、
元のオプションで一度 `taraba build` を実行してください。
公開用 `build.json` は生成元の版やサイズを記録します。公開済み npm ライブラリの利用者は、通常通りそのライブラリを更新します。

Rust の要求バージョンは Cargo.toml/Cargo.lock に従います。必要なら使用中の
`taraba` / `taraba-helpers` の要求版と lockfile を更新してから再生成します。
Cargo ビルドは、別名・推移的依存も含めて private runtime の互換系列を検査します。
0.x では minor が一致する版、0.0.x では同じ patch、prerelease は同じ版が必要です。1.x 以降は major を揃えます。
allocator はこの JS ABI の版検査とは独立です。raw Wasm からは Rust の依存版を取得できないため、
CLI の互換系列をまたぐ更新ではソースから再ビルドし、明示的に `taraba build` を実行します。
アプリ/npm の version の引き上げや publish は行いません。

## 開発中の自動ビルド

Cargo プロジェクト内で `taraba build --watch` を実行すると、起動直後とファイル変更時に Cargo の release / wasm32-unknown-unknown ビルドから成果物生成まで実行します。WIT の既定値は選んだ package の `wit/` です。Core の JSPI/Future はビルドごとに自動選択します。Component は `--component` を指定します。

```sh
taraba build --watch
taraba build --watch --future
taraba build --watch --component --npm-name @example/orders --license MIT
```

workspace や Cargo feature は次のように指定します。Cargo の JSON 出力から実際の Wasm を取得するため、独自の target directory や `[lib].name` にも対応します。

```sh
taraba build --watch --manifest-path crates/orders/Cargo.toml \
  --package orders --no-default-features --features std \
  --wit crates/orders/wit --out-dir web/pkg
```

Rust、WIT、Cargo.toml / Cargo.lock、Cargo 設定、解決されたローカル path 依存とアセットの変更を監視します。連続した変更を150 msの待機でまとめ、ビルドを直列化します。ビルド中の変更は次のビルドで処理します。Cargo の target directory、出力先、`.git`、`node_modules`、`.cache`、一時出力を除外して再ビルドループを防ぎます。

watch の出力ディレクトリは生成物専用です。既存の非空ディレクトリは taraba の `build.json` を持つものを使用します。別ディレクトリで生成に成功してから置き換えます。Rust のコンパイルや WIT の検証に失敗しても直前の出力を保持し、次の編集で再試行します。起動時には有効な Cargo manifest と選択可能な cdylib package が必要です。停止は Ctrl-C です。

ビルド済み Wasm の更新だけを監視する場合は、従来の入力形式に `--watch` を追加します。この形式では Wasm と WIT を監視し、Cargo のコンパイルは外部のビルド工程が担当します。

```sh
taraba build target/wasm32-unknown-unknown/release/orders.wasm \
  --wit wit --watch --out-dir pkg
```

`--manifest-path` / `--package` / `--features` / `--no-default-features` は、Wasm 入力を省略した Cargo プロジェクトの build / watch で使えます。`--world`、実行方式、`--debug`、`--npm-name` など、各ビルド形式のオプションは再ビルドにも引き継ぎます。

## インストール

Rust 1.85 以上を用意し、crates.io から CLI をインストールして Wasm ターゲットを追加します。ライブラリの依存クレートは `taraba new` が生成する Cargo.toml に定義され、Cargo が取得します。

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
taraba build --component --out-dir pkg
```

`pkg/app.component.wasm` を最適化・Component 化・validate し、選択した WIT world との適合も検査します。`app.wit` は生成された Component の契約、`build.json` は ABI 情報です。複数の world は `--world` で選択します。Canonical ABI のメタデータを保ち、Core 用の externref lowering は適用しません。

ドメイン契約には WIT の record / list / string / result を使えます。interface や resource の所有権も標準ツールが生成します。native async の実行にはその proposal に対応した Component host が必要です。今回のライブラリ検証は validate と jco 出力の実行であり、全 native host での動作確認ではありません。WASI 実装や Preview 1 adapter は自動で付与しません。宣言した import はホスト側から提供します。

## allocator の構成を選ぶ

生成する Cargo.toml は Wasm の小ささを優先し、taraba-allocator を
`default-features = false` で指定します。用途に応じて、その依存の features に追加します。

| 用途 | features |
|---|---|
| コードサイズを最小にする | なし |
| 小さな領域の確保が多い | `size_classes`。main free list と実測で比較する |
| 25→28→25 Bなど、同じ4 B単位の丸め結果に収まる拡縮が多い | `realloc_in_place` |

両 feature は併用できます。`realloc_in_place` は既定で無効で、丸めたワード数が変わる
拡縮では通常の allocate/copy/free に戻ります。専用の拡縮ベンチと、一般的な Vec の
成長は別の処理です。[allocator のサイズ・速度比較](allocator.md)で両構成と共通の検証条件を
確認できます。数値だけを扱う JSPI の例は汎用確保を行わないため、allocator の変更が
成果物のサイズに現れない場合があります。

## TypeScript 型定義込みの npm ライブラリ

上の Component プロジェクトから次を実行します。

```sh
pnpm add -D @bytecodealliance/jco@1.39.0
taraba build --component --jco node_modules/.bin/jco \
  --npm-name @example/orders --npm-version 0.1.0 --license MIT --out-dir pkg
cd pkg
pnpm pack
```

ESM exports、`types` 条件、配布ファイルの明示的な `files` 一覧を持つ `package.json` と、実行に必要な JS / Wasm / 型定義を生成します。jco が WIT からアプリ固有の型、`Promise<T>`、ドメイン型を生成します。元の Component は `@example/orders/component.wasm`、その WIT は `@example/orders/wit` からも参照できます。jco / wasm-tools / taraba はビルド時のツールで、生成パッケージの実行時依存には入りません。ビルド処理は publish を行いません。名前以外の既定値は選んだ Cargo package の版・ライセンスを引き継ぎ、ライセンス未指定時は `UNLICENSED` とします。

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
taraba build \
  --npm-name @example/tiny --npm-version 0.1.0 --license MIT
```

```js
import { readFile } from 'node:fs/promises';
import { createHost } from '@example/tiny';

const host = createHost({ bindings: { add: async (a, b) => (a + b) | 0 } });
const { instance } = await WebAssembly.instantiate(
  await readFile(new URL(import.meta.resolve('@example/tiny/app.wasm'))),
  host.imports,
);
host.attach(instance.exports);
console.log(await host.run(20, 21)); // 型は Promise<number>
```

Core の JSPI/Future は `createHost` → 標準の Wasm instantiation → `attach` を基本にします。`WebAssembly.compile` した Module や `instantiateStreaming` も利用者が選べます。Core の export は `createHost` のみとし、独自の loader は生成しません。Component の例は引き続き jco の生成した `instantiate` を使います。

Core では WIT から `AppBindings`、`AppExports`、`AppHost` を生成し、関数名と引数を TypeScript で検査します。既定の `pkg/index.js` / `index.d.ts` と package.json の exports から同じ型付き API を利用できます。メソッドを静的に生成するため、文字列による呼び出しなしで `host.run(a, b)` を補完できます。共有ランタイムは `runtime.mjs` / `runtime.d.mts` に分離します。どちらも `--debug` で説明付きエラーを選べ、release ではコードと[説明ページ](error-codes.md)へのリンクを出力し、説明辞書は同梱しません。

Core/JSPI は I/O 待ちも含めて instance ごとに直列化します。host reject / trap は instance を閉じ、キャンセルやその経路での Rust Drop は保証しません。任意の Rust Future や native WIT async を駆動する executor ではありません。既存 executor の独立タスク進行・キャンセルが必要なら `--future` を選びます。こちらの WIT Promise resource には中身の型がないため、TS も正確に `Promise<unknown>` とします。WIT から async 戻り値まで型を付ける場合は Component を使います。[Core ランタイムの詳細](core-runtime.ja.md)に所有権・task 上限・エラー契約を分離しています。

## JS の標準機能を使うヘルパー

Core JSPI / Future の Rust 実装内では、オプションの `taraba-helpers` で RegExp、JS 文字列、Unicode 正規化、分割、文字コード変換を使えます。crates.io の依存で必要な feature を有効にし、通常通り `taraba build` します。アプリの公開 WIT にヘルパーの private WIT を追加したり、手動で JS bindings を渡したりする必要はありません。

ビルドは wasm-opt 後の import から必要な文字列・Iterator・Segmenter・Decoder 関数だけを生成します。未使用のヘルパーによる追加 JS は 0 B です。文字列機能の使用時には共通ハンドル基盤も含めます。[選択できる機能](helpers.ja.md#使う機能だけを含める)・[文字列サンプルと実測サイズ](strings.ja.md)を参照してください。

この private Core ABI は、公開 WIT の `string` / record / list を扱う Component の Canonical ABI とは別です。ヘルパーは `--component` や JS のない WASI host には対応しません。

## サイズ・互換性・検証

複数の Core ライブラリは、同じ URL の ESM に解決すれば JS ランタイムを共有できます。既定の npm 出力はパッケージごとにコピーを持つため、共通チャンクへの集約が必要です。[ESM キャッシュの検証とビルド例](esm-cache.ja.md)にサイズの実測と instance 分離の確認を載せています。

JavaScript の async 実行環境は Safari 27+ / JSPI 対応 V8 を前提とします。Safari 27 実ブラウザーは未検証です。Component async / jco は upstream でも実験扱いです。その scheduler・所有権・キャンセルの契約は Component toolchain のもので、Core Future の契約とは区別します。

現在の scalar async 比較は [taraba / Embassy / wasm-bindgen](async-size.ja.md)です。過去のスナップショットは [WIT / Core / Component](wit-comparison.md)、[並行 JSPI](jspi-concurrent.md)に分けています。これらは測定時点の値で、すべての npm 出力のサイズではありません。npm の `build.json` には JS、型定義、配布する Wasm のサイズを分けて記録します。Component container も配布に含めるため、tarball 全体と実際の実行時ダウンロード量は異なります。

JSPI Future adapter と stack snapshot による並行 JSPI は `experiments/` に残し、ライブラリの通常ビルドには組み込みません。[採用条件](jspi-adoption.md)を参照してください。

検証コマンドと検証範囲は[開発ガイド](development.ja.md)にまとめています。

runtime / CLI / JS は MIT、任意で使う `taraba-allocator` は wee_alloc 由来の MPL-2.0 です。配布時も allocator のライセンスとソースに関する条件を維持してください。[THIRD_PARTY.md](../THIRD_PARTY.md)。

生成 npm には MIT/MPL の通知と、allocator の版を指定したソース取得先を同梱します。
アプリ自身のライセンスは別です。別版・改変版の MPL 対象依存を使う場合は通知を更新してください。
[ライセンスと来歴](https://github.com/mizchi/taraba/blob/main/THIRD_PARTY.md)を参照してください。
