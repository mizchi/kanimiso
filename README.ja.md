# kanimiso

[English](README.md) | 日本語

JavaScript ホスト向けの小さな Rust/Wasm 非同期ランタイムです。Rust の Future を native Promise に接続し、`spawn_local`、Promise の await、キャンセルを提供します。`std` / `no_std + alloc` に対応し、JS オブジェクトの実体はホスト側に保持します。

公開インターフェースは **WIT**、Rust の型・Guest・import/export は公式 **wit-bindgen** で生成します。実行形式は **Core Wasm + externref** です。この軽量プロファイルの JS root 管理は Component Model の Canonical ABI とは異なります。標準 Component async との同一アルゴリズムによる実測は [比較結果](docs/wit-comparison.md) にあります。

## インストールと利用

`kanimiso`、`kanimiso-allocator`、`kanimiso-cli` の初回 crates.io 公開を準備中です。以下は公開後の利用手順です。まだレジストリからのインストール成功は保証していません。公開自体は実施していません。

```sh
rustup target add wasm32-unknown-unknown
cargo install kanimiso-cli --version 0.1.0 --locked
# Binaryen 133 の wasm-opt / wasm-as / wasm-merge / wasm-metadce を PATH に置く
kanimiso new hello --no-std
cd hello
cargo build --release --target wasm32-unknown-unknown
kanimiso build target/wasm32-unknown-unknown/release/hello.wasm --wit wit --out-dir pkg
```

CLI はビルド済み JS と intrusive pool の WAT を内包します。利用者によるこのリポジトリの checkout や Node/esbuild でのホスト生成は不要です。Binaryen は外部ツールです。PATH の代わりに `KANIMISO_BINARYEN=/path/to/bin` または `--binaryen /path/to/bin` を指定できます。

`new` はレジストリのバージョン依存を使う独立した Cargo プロジェクトを生成します。生成例の stack は 64 KiB、memory 上限は 1 MiB で、`.cargo/config.toml` から変更できます。既存のプロジェクトでは次の依存を追加し、生成例と同じ WIT / `export_runtime!()` を利用します。

```sh
cargo add kanimiso@0.1.0 --no-default-features
cargo add kanimiso-allocator@0.1.0 --no-default-features
cargo add wit-bindgen@=0.58.0 --no-default-features --features macros
```

`--no-std` を付けない `new` は std 構成です。JS 用 allocator はアプリ側で選択します。`kanimiso-allocator` は `wee_alloc` 由来の MPL-2.0 の fork で、以前の実験名 `wee-port` から改名しています。最小構成は size classes を無効にします。

生成された `pkg/app.wasm` と `pkg/kanimiso.mjs` を一緒に配信します。ブラウザーでは Wasm を fetch して ArrayBuffer にし、Node.js では次のように使えます。

```js
import { readFile } from 'node:fs/promises';
import { instantiate } from './pkg/kanimiso.mjs';

const host = await instantiate(await readFile('./pkg/app.wasm'), {
  bindings: { add: async (a, b) => (a + b) | 0 },
});
console.log(await host.promise('run', 20, 21)); // 42: await add(20,21), await add(41,1)
```

`--debug` は説明付きエラーを含む JS を出力します。release は短いエラーコードを使い、`pkg/error-codes.json` で説明を確認できます。型宣言とビルド情報も pkg に出力します。

## WIT の範囲と所有権

```wit
package example:app@0.1.0;
interface js { resource promise; }
world app {
  import js;
  use js.{promise};
  import add: func(a: s32, b: s32) -> promise;
  export run: func(a: s32, b: s32) -> promise;
}
```

Core プロファイルは s32 / u32 / f64 と、JS に実体を置く imported resource の own / borrow を扱います。borrow は import 引数のみです。string、list、record、exported resource、WIT native async は未対応としてビルドを失敗させます。resource は `undefined` 以外の JS 参照を表し（`promise` は Promise を返す契約）、WIT の `promise` resource を返す同期境界の内側で Rust async を動かします。アプリ import は `bindings` に渡し、同名の関数を複数 interface から import する構成は拒否します。

生成された resource の handle と `JsPromise` の間の変換は、この Core プロファイル内でのみ有効です。別の Component host にそのまま渡せる canonical resource handle ではありません。raw ポインター・root ID・`rt_*` は非公開 ABI です。アプリ関数は host の `call` / `promise` 経由で呼び出してください。

## 検証と制約

single-agent、非共有 wasm32 memory、`alloc`、現代の JS/Wasm エンジンを対象にします。固定 pool は 128 B × 1,024 slots、Future の大きさ・alignment に上限があります。大きな Future に対応する汎用 executor ではありません。JS roots は参照保持だけを行い、JS オブジェクトを線形メモリーへコピーしません。fatal 時は最初のエラーで停止し、JS roots を解放します。壊れた Rust Drop は再試行しません。

V8 と system JavaScriptCore shell、および local workerd で検証します。JSC shell の queueMicrotask は Promise job で補います。Safari 実ブラウザーと Cloudflare 本番への deploy は未検証です。js-string / exnref / typed funcref / GC の機能検証と、通常ランタイムがそれら全てを使うことは別です。Kani は native 64-bit の限定されたモデル・部品の検証で、JS・エンジン・Wasm 全体の証明ではありません。

抽出時点の過去の結果は [verification.md](docs/verification.md) と [JSON](docs/verification.json)、来歴は [provenance.json](provenance.json) にあります。パス変更前のハッシュやサイズは現在の測定値として流用しません。

## 開発者向け

```sh
git clone https://github.com/mizchi/kanimiso.git
cd kanimiso
just setup
just check
just package-check  # .crate を展開・インストールし、repo 外の利用アプリを std/no_std で実行
just compare-wit
just modern
just stress 60
just workers
just miri
just kani
```

Node.js 24+、pnpm、Rust、just が必要です。WIT 比較には `wasm-tools 1.245.1`（`cargo install wasm-tools --version 1.245.1 --locked`）も必要です。`package-check` は未公開の依存を展開した .crate へ patch して検証します。レジストリ経由のインストール確認とは区別しています。実際の crates.io / npm への publish は行いません。

ライセンスは runtime / CLI / JS が MIT、allocator が MPL-2.0。[THIRD_PARTY.md](THIRD_PARTY.md) を参照してください。
