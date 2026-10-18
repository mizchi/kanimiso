# Core ランタイムの詳細

[English](core-runtime.md) | 日本語

旧名は `kanimiso` です。crate・CLI・生成ファイル・WIT の名前空間を `taraba` に統一しました。

JavaScript ホスト向けの小さな Rust/Wasm ランタイムです。実験環境の前提は **Safari 27 以降、JSPI 対応 V8** です。Safari 27 の JSPI 対応は [WebKit の公式発表](https://webkit.org/blog/18325/webkit-features-for-safari-27-0/#webassembly)で確認しています。

公開インターフェースは **WIT**、Rust の型・Guest・import/export は公式 **wit-bindgen** で生成します。実行基盤は JSPI を既定とし、Future 対応は明示的に選択します。

- **JSPI scalar** (既定。`--jspi` でも明示可能): 同期 WIT 関数の I/O を native Promise に接続し、エンジンで Wasm を suspend / resume します。Rust executor・task pool を持たない省サイズ構成です。
- **Future** (`--future`): `spawn_local`、Rust Future、JS Promise の await、キャンセルを提供する既存構成です。`std` / `no_std + alloc` に対応し、JS オブジェクトはホスト側に保持します。

両者の Core lowering は Component Model の Canonical ABI とは異なります。標準 Component native async を含む比較は [測定結果](wit-comparison.md)、エンジンの前提は [engine-baseline.md](engine-baseline.md) にあります。

JSPI で Rust Future を駆動する別の[アダプター実験](../experiments/jspi-future/README.md)もあります。将来は JSPI 上の追加機能として Future 対応を提供する方針です。このアダプターは引き続き実験扱いで、製品 API には含めません。並行実行・キャンセルと Drop・同時実行時のメモリと速度の検証を終えるまでは既存 Future バックエンドも維持します。[採用方針](jspi-adoption.md)を参照してください。

[同一インスタンスの並行実行実験](../experiments/jspi-concurrent/README.md)では、直接 JSPI と bounded Future アダプターの両方に spill stack の snapshot と Wasm トランポリンを追加し、一つの I/O が停止している間も別の呼び出しを進めます。製品には未採用で、既定の JSPI は引き続き直列実行です。配信サイズ・即時／遅延時間・Node のプロセスメモリは[測定結果](jspi-concurrent.md)を参照してください。

## インストールと利用

`taraba`、`taraba-allocator`、`taraba-cli` の初回 crates.io 公開を準備中です。以下は公開後の利用手順です。まだレジストリからのインストール成功は保証していません。公開自体は実施していません。

```sh
rustup target add wasm32-unknown-unknown
cargo install taraba-cli --version 0.1.0 --locked
# Binaryen 133 の wasm-opt / wasm-as / wasm-merge / wasm-metadce を PATH に置く
taraba new hello --no-std
cd hello
cargo build --release --target wasm32-unknown-unknown
taraba build target/wasm32-unknown-unknown/release/hello.wasm --wit wit --out-dir pkg
```

CLI はビルド済み JS と intrusive pool の WAT を内包します。利用者によるこのリポジトリの checkout や Node/esbuild でのホスト生成は不要です。Binaryen は外部ツールです。PATH の代わりに `TARABA_BINARYEN=/path/to/bin` または `--binaryen /path/to/bin` を指定できます。

`new` はレジストリのバージョン依存を使う独立した Cargo プロジェクトを生成します。生成例の stack は 64 KiB、memory 上限は 1 MiB で、`.cargo/config.toml` から変更できます。JSPI の生成例は `wit-bindgen` と allocator のみを依存に持ちます。既存の Future 構成を使うプロジェクトでは次の依存と `export_runtime!()` を利用します。

```sh
cargo add taraba@0.1.0 --no-default-features
cargo add taraba-allocator@0.1.0 --no-default-features
cargo add wit-bindgen@=0.58.0 --no-default-features --features macros
```

`--no-std` を付けない `new` は std 構成です。既存 Future 構成は `new` と `build` の両方で `--future` を指定します。従来の Future 用 build コマンドにも、このフラグを追加してください。WIT から実行系を暗黙に切り替えることはありません。`--jspi` も引き続き指定でき、`--future` との併用はエラーにします。JS 用 allocator はアプリ側で選択します。`taraba-allocator` は `wee_alloc` 由来の MPL-2.0 の fork で、以前の実験名 `wee-port` から改名しています。最小構成は size classes を無効にします。

生成された `pkg/app.wasm` と `pkg/taraba.mjs` を一緒に配信します。ブラウザーでは Wasm を fetch して ArrayBuffer にし、Node.js では次のように使えます。

```js
import { readFile } from 'node:fs/promises';
import { instantiate } from './pkg/taraba.mjs';

const host = await instantiate(await readFile('./pkg/app.wasm'), {
  bindings: { add: async (a, b) => (a + b) | 0 },
});
console.log(await host.promise('run', 20, 21)); // 42: await add(20,21), await add(41,1)
```

`--debug` は説明付きエラーを含む JS を出力します。release は短いエラーコードを使い、`pkg/error-codes.json` で説明を確認できます。型宣言とビルド情報も pkg に出力します。

## JSPI scalar の WIT と実行契約

```wit
package example:app@0.1.0;
world app {
  import add: func(a: s32, b: s32) -> s32;
  export run: func(a: s32, b: s32) -> s32;
}
```

Rust からは同期関数として呼びます。JS の `bindings.add` が返した Promise を `WebAssembly.Suspending` が待機し、エクスポートは `WebAssembly.promising` で Promise に変換します。s32 / u32 / f64 と戻り値なしの関数が対象です。resource、string、list、record、WIT native async はこの省サイズ構成では未対応です。

同じインスタンスの呼び出しは I/O 待機も含めて直列化し、遅い呼び出しが後続を待たせます。これは LLVM が線形メモリーに置くスタックを、待機中の再入で壊さないためです。binding から同じインスタンスを await する再入、キャンセル、任意の Rust Future を poll する executor は提供しません。ホストの reject / Wasm trap は最初の理由を保って instance を閉じ、キュー中の呼び出しも同じ理由で reject します。JS 例外で Rust の Drop が実行されるとは仮定しません。

JSPI のないエンジンでは `RT15` で失敗し、互換フォールバックは行いません。アプリ呼び出しは `host.call` / `host.promise` のどちらも Promise を返します。`taraba.d.mts` はこの構成専用の型を含みます。

## Future 構成の WIT と所有権

`taraba new hello --no-std --future` と `taraba build ... --wit wit --future` で従来の Future 構成を使います。一つのタスクが I/O を待つ間も、独立した別のタスクを進められます。WIT は `resource promise` を import し、`add: func(a:s32,b:s32)->promise` と `run: func(a:s32,b:s32)->promise` を定義します。

Future 構成は s32 / u32 / f64 と、JS に実体を置く imported resource の own / borrow を扱います。borrow は import 引数のみです。string、list、record、exported resource、WIT native async は未対応としてビルドを失敗させます。resource は `undefined` 以外の JS 参照を表し（`promise` は Promise を返す契約）、WIT の `promise` resource を返す同期境界の内側で Rust async を動かします。アプリ import は `bindings` に渡し、同名の関数を複数 interface から import する構成は拒否します。

生成された resource の handle と `JsPromise` の間の変換は、この Core プロファイル内でのみ有効です。別の Component host にそのまま渡せる canonical resource handle ではありません。raw ポインター・root ID・`rt_*` は非公開 ABI です。アプリ関数は host の `call` / `promise` 経由で呼び出してください。

## 検証と制約

single-agent、非共有 wasm32 memory を対象にします。Future 構成は `alloc` を使い、固定 pool は 128 B × 1,024 slots、Future の大きさ・alignment に上限があります。大きな Future に対応する汎用 executor ではありません。JS roots は参照保持だけを行い、JS オブジェクトを線形メモリーへコピーしません。fatal 時は最初のエラーで停止し、JS roots を解放します。壊れた Rust Drop は再試行しません。

V8 と system JavaScriptCore shell、および local workerd で検証します。JSC shell の queueMicrotask は Promise job で補います。手元の古い system JSC は JSPI の前提外として記録します。JSPI の std/no_std は local workerd でも共通3,507ケースと二回の待機を通過しています。Safari 27 実ブラウザーと Cloudflare 本番への deploy は未検証です。js-string / exnref / typed funcref / GC の機能検証と、通常ランタイムがそれら全てを使うことは別です。Kani は native 64-bit の限定されたモデル・部品の検証で、JS・エンジン・Wasm 全体の証明ではありません。

抽出時点の過去の結果は [verification.md](verification.md) と [JSON](verification.json)、来歴は [provenance.json](../provenance.json) にあります。パス変更前のハッシュやサイズは現在の測定値として流用しません。

## 開発者向け

```sh
git clone https://github.com/mizchi/taraba.git
cd taraba
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

Node.js 24+、pnpm、Rust、just が必要です。setup は `wasm-tools 1.245.1`（`cargo install wasm-tools --version 1.245.1 --locked`）も必要です。`package-check` は未公開の依存を展開した .crate へ patch して検証します。レジストリ経由のインストール確認とは区別しています。実際の crates.io / npm への publish は行いません。

ライセンスは runtime / CLI / JS が MIT、allocator が MPL-2.0。[THIRD_PARTY.md](../THIRD_PARTY.md) を参照してください。
