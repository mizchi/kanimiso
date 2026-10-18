# kanimiso

JavaScript の Promise を利用する、小さな Rust/Wasm 向け single-agent runtime。
`std` / `no_std` の両方に対応し、`wasm-bindgen` や Tokio を必要としない。

Rust crate は `kanimiso`、JS パッケージ名は `@mizchi/kanimiso`。
現在は Git checkout から使う実験版で、npm / crates.io には公開していない。

```sh
just setup
just check
```

必要環境: Node.js 24+、pnpm 12.11.2、just、Rust 1.98.0。
`just setup` が Wasm target と SHA-256 を照合した Binaryen 133 を用意する。
元の wasm-battleground の checkout、ビルド成果物、結果 JSON は不要。

## 使い方

```js
import { readFile } from "node:fs/promises";
import { instantiate } from "./dist/index.mjs";

const runtime = await instantiate(
  await readFile("dist/examples/no_std-minimal.wasm"),
  { deferredAdd: (a, b) => Promise.resolve((a + b) | 0) },
);
console.log(await runtime.promise("start", 7, 9)); // 17（2段の await）
```

`deferredAdd` は移植元テストとの互換用サンプル I/O。アプリ独自の import は
`bindings: { fetchData: (...) => ... }` のように指定し、Wasm の `app` モジュールから参照する。
返された runtime の `call` / `promise` を通して Wasm を呼ぶ。
生の `instance.exports` を直接呼ぶと fatal guard の契約を迂回する。
JS の型は [src/index.d.ts](src/index.d.ts)、エラーコードは [src/error-codes.json](src/error-codes.json)。
`./dist/index-debug.mjs` では同じコードに説明メッセージが付く。

```rust
use kanimiso::{future_to_promise, JsPromise, spawn_local};

fn launch(promise: JsPromise) -> JsPromise {
    future_to_promise(async move {
        let value = promise.await?;
        Ok(value)
    })
}

fn detached() {
    let _handle = spawn_local(async { /* Rust の Future */ });
}
```

Rust のアプリは `wasm32-unknown-unknown` 向け cdylib とし、
`rt_poll` / `rt_drop` / `rt_settle` を提供する。[examples/promise](examples/promise) に完全な実装がある。
`no_std` ではアプリが panic handler と allocator を選ぶ。
同梱の `wee-port` は任意の汎用 allocator。タスク自身は固定領域から確保する。

## アプリのビルド

アプリの参照境界を明示した ABI manifest を渡す。任意の関数名を利用できる。

```json
{
  "imports": {
    "app.fetchData": { "params": ["i32"], "result": "own" }
  },
  "exports": {
    "run": { "params": ["i32"], "result": "own" }
  }
}
```

```sh
node tools/build-wasm.mjs target/wasm32-unknown-unknown/release/app.wasm \
  --abi abi.json --output dist/app.wasm
```

`i32` / `f64` は scalar、`own` は所有する JsValue/JsPromise root の受け渡し、
`borrow` は import の引数だけで使える借用。`own` の生 Rust 型は `u32`、変換後は `externref`。
manifest と実際の Wasm signature が違う場合はビルドを失敗させる。
`rt_*` と `jsrt` は予約済み。アプリの import は `app` namespace に分離する。
`own` / `borrow` を使う未宣言の関数を自動推測しない。

ビルドツールは externref ABI 変換 → intrusive pool 結合 → 不要 export 除去 →
`wasm-opt -Oz --flatten --rereloop -Oz --converge` → private import 名変換を行う。
Wasm と JS は同時にビルドした組み合わせを使う。minifier の import map を別バージョンと混ぜない。
この版の binder は `i32` / `f64` と参照の明示的な境界のみを扱い、一般的な Rust binding generator ではない。

## 実行契約

- `spawn_local` の最初の poll は microtask まで遅延し、重複 wake をまとめる。
- JoinHandle の Drop は detach。明示的な cancel で Future と購読を破棄する。
- 成功結果は Rust Drop の完了後に Promise へ確定する。
- 致命的な import 例外・Wasm trap では最初の例外を保持し、全タスクを reject、JS roots を解放する。
  fatal 後に Rust の Drop を再実行せず、instance を再利用しない。
- 外部の reject 値はオブジェクト同一性を維持し、別の Error で包まない。
- token ID を再利用せず、遅延した Promise 解決や古い Waker が別タスクに届くことを防ぐ。
- 非共有メモリー、single-agent のみ。JS の worker 間で runtime を共有しない。

タスク領域は **128 KiB / 128 B × 1024 slots / alignment ≤ 64**。
Future 本体・header 等を合わせて slot を超える場合や同時タスク上限は fatal OOM となる。
これは汎用の無制限 executor ではない。線形メモリーの初期値はサンプルで 256 KiB、最大 1 MiB。
`no_std` 最小サンプルには汎用 allocator のコードがリンクされない。

対象は V8 / Safari。`Promise.withResolvers`、`externref`、`queueMicrotask` を使う。
新しい Wasm 機能は `just modern` で動作を確認する。Safari 実ブラウザーの検証は未完了で、
macOS の system JavaScriptCore shell での確認とは区別する。

## 検証

```sh
just check       # Node unit、native Rust、実際の std/no_std Wasm、回帰・OOM・fuzz
just stress 60   # 60秒以上、同一 seed の std/no_std を差分比較
just miri       # Waker・型・storage layout・汎用 allocator
just kani-setup # optional: Kani 0.67.0
just kani       # Waker / allocator 実装の限定された proof と ID モデル
just workers    # local workerd。Cloudflare 本番へは deploy しない
just modern     # js-string / exnref / typed funcref / GC の機能プローブ
```

Kani は native 64-bit の限定された部品・モデルの検証であり、JS engine や intrusive WAT、
Wasm コード生成、runtime 全体の形式証明ではない。
エラー・Drop・再入・stale Waker・OOM は実際の Wasm を使うテストでも確認する。
結果は `.cache/check.json` / `stress.json` / `workers.json` / `modern.json` へ保存する。
抽出時の確認結果は [docs/verification.md](docs/verification.md)。

## 構成と来歴

- `crates/kanimiso`: Rust API、Promise Future、Waker、固定 backing storage。
- `src`: JS host、エラーコード、intrusive WAT allocator、JS / TypeScript API。
- `tools/bridge`: ABI manifest を使う externref 変換器。
- `examples/promise`: std/no_std の同一アルゴリズムと別ビルドの probe。
- `tests`: unit と実 Wasm の回帰・失敗・差分 fuzz。
- `verification/kani`: 部品の proof harness と ID モデル。
- `crates/wee-port`: wasm32 向け汎用 allocator。MPL-2.0。

wasm-battleground の作業ツリーから抽出した。元の比較実験・計測履歴は元リポジトリに残す。
`provenance.json` は抽出元ファイルの SHA-256 を記録する。
抽出後の変更はローカル依存の解消、公開名、ABI manifest、guarded application bindings、
パッケージ loader と検証タスクの追加。元の測定値を抽出後のサイズとして流用しない。

本体は MIT、`crates/wee-port` は MPL-2.0。[THIRD_PARTY.md](THIRD_PARTY.md) を参照。
