# Panic reporting / panic の通知

Core JSPI / Future で任意に有効にする機能です。release は Rust の panic を `PN01` と説明ページの URL を持つ JS Error に変換します。debug は Rust のメッセージとソース位置も渡せます。既存アプリの hook や雛形の panic handler をビルド時に書き換えることはありません。Component には適用しません。

This opt-in API works with both Core profiles. Release reports a JS Error containing `PN01` and its documentation URL; diagnostic builds can include the Rust message and location. Existing hooks/handlers are not rewritten, and the Component path is unchanged.

## std

`taraba` の `std` feature を有効にし、panic し得る処理に入る前に呼びます。JSPI でもこの crate を使えます。Future executor の export は不要です。

Enable the crate's `std` feature and install before running application code. JSPI applications can use this API without exporting the Future executor.

```toml
[dependencies]
taraba = { version = "0.1.0", features = ["std"] }
```

```rust
fn run() {
    taraba::panic::set_hook();
    // Application code, including code that can panic.
}
```

最初の呼び出しだけ既存の hook を置き換えます。繰り返し呼んでも再登録しません。後からアプリが設定した hook は上書きしません。

The first call replaces the current hook. Repeated calls do not reinstall it or overwrite a hook installed later by the application.

## no_std

アプリが定義する handler から呼びます。`taraba` crate の既定は `no_std` です。

The application owns its panic handler; the crate defaults to `no_std`.

```rust
#[panic_handler]
fn panic(info: &core::panic::PanicInfo<'_>) -> ! {
    taraba::panic::handler(info)
}
```

## Release / debug

| Rust のビルド / Rust build | JS のビルド / JS build | 通知内容 / Report |
|---|---|---|
| release | `taraba build` | `PN01` + URL。hook/handler 自身は整形しない / no formatting in this hook/handler |
| release | `taraba build --debug` | `PN01: Rust panic` + URL。Rust の詳細は生成していない / no Rust details available |
| debug assertions または `panic-details` feature | `taraba build --debug` | コード・URL・Rust の詳細 / code, URL and Rust details |
| debug assertions または `panic-details` feature | JS release | コード・URLのみ。JS は詳細を読まない / JS ignores details |

`taraba build` は Cargo の release profile でコンパイルします。`--debug` は JS のエラー説明を切り替える指定で、Cargo の profile は変えません。最適化を維持して Rust の詳細も調べるには、アプリの feature を追加します。

`taraba build` uses Cargo's release profile; `--debug` controls JS diagnostics, not Cargo's profile. Forward the diagnostic feature to retain Rust details in optimized builds:

```toml
[features]
panic-details = ["taraba/panic-details"]
```

```sh
taraba build --features panic-details --debug
```

Rust を通常の debug profile で別途ビルドした場合も、生成された `.wasm` を `taraba build <file.wasm> --wit wit --debug` に渡せます。詳細の読み出しには、`memory` export と `host.attach(instance.exports)` が必要です。attach 前の panic も `PN01` として扱いますが、Rust の詳細は読みません。

An independently compiled Cargo debug `.wasm` can also be passed to `taraba build <file.wasm> --wit wit --debug`. Reading details requires an exported `memory` and an attached host. A panic before attach still reports `PN01`, without reading the text buffer.

```js
try {
    await host.run();
} catch (error) {
    if (error.code === "PN01") {
        console.error(error);
        // Create a new host and instance to restart.
    }
}
```

JS Error の stack をそのまま使い、JS のスタック文字列を Rust に往復させません。追加の console 出力は行わず、呼び出しの例外・Promise rejection として伝えます。最初の fatal 理由を保って instance を閉じ、Future の保留タスクも同じ理由で reject します。Rust の unwind / Drop は実行しません。通常の Wasm trap や外部例外は書き換えません。

The report uses a JS Error stack directly, without copying a JS stack string through Rust. It propagates as an exception/Promise rejection, with no extra console output. Reporting closes the instance and rejects pending Future tasks with the same first-fatal error. It does not unwind Rust or run destructors. Native Wasm traps and foreign exceptions retain their original identity.

## サイズ / Size

release の通知は空の slice を渡し、hook/handler 自身は panic の詳細を整形・コピーしません。ただし `std` は hook を呼ぶ前に動的 payload を整形する場合があり、その allocation は hook だけでは省けません。`std::panic::set_hook` は `std` の panic 基盤そのものを除去しません。Wasm 内の panic 用文字列・ソース位置・fmt がすべて消える保証はありません。`no_std` の release handler はこの基盤を経由しません。通常の `format!` はそのまま動きます。

Release sends an empty slice without formatting/copying details in the hook/handler itself. `std` can format a dynamic payload **before** invoking the hook, so this API cannot eliminate those allocations. Installing a hook does **not** remove `std`'s panic infrastructure or guarantee removal of panic strings, source locations or formatting code from Wasm. The no_std release handler bypasses that infrastructure. Ordinary `format!` remains functional.

参照した [console_error_panic_hook](https://github.com/rustwasm/console_error_panic_hook/blob/master/src/lib.rs) は panic 情報の文字列化と JS Error の stack の取り込みを行います。taraba の release 経路はそれらを行わず、debug の整形コードをコンパイル時に分離します。panic 関数を一括 snip する方法とは異なり、hook の通知と通常の整形処理を維持します。

The reference implementation formats panic information and copies a JS Error stack into a Rust string. taraba's release path omits both; Rust diagnostic formatting is compiled separately. Unlike blanket panic/fmt snipping, it preserves reporting and normal formatting.

`just panic-check` で、同じ処理の hook 有無を比較し、std/no_std × JSPI/Future × release/debug/最適化付き詳細出力を実際の V8 で確認します。通常の計算・format、Future の poll 内の panic、最初の fatal の保持、通常 trap の識別を検証します。サイズは `.cache/panic-reporting/check.json` に保存します。Safari 実ブラウザーは未検証です。

Run `just panic-check` for the same baseline/hook algorithm across std/no_std, JSPI/Future and release/debug/optimized diagnostic builds on V8. It checks normal computation/formatting, panic during Future polling, first-fatal identity, native traps and payload formatting before the hook. Sizes are recorded in `.cache/panic-reporting/check.json`; Safari browser execution remains unverified.

### 2026-10-19 の最適化後の比較 / Optimized snapshot (2026-10-19)

| 構成 / Profile | release Wasm B | `panic-details` Wasm B | 差 / Difference B |
|---|---:|---:|---:|
| JSPI no_std | 3,638 | 6,457 | −2,819 |
| JSPI std | 7,475 | 8,348 | −873 |
| Future no_std | 4,144 | 7,209 | −3,065 |
| Future std | 8,189 | 9,061 | −872 |

両列とも同じ Rust release 最適化と Binaryen 133 を使い、違いは `panic-details` の有無です。通常の数値計算・format、意図的な panic/trap、hook 差し替え、整形回数の計測用 export を含む検証 fixture 全体のサイズで、最小 runtime 単体のサイズではありません。hook を付ける前より小さくなるという意味でもありません。JS は別計上です。現在の共有 runtime のサイズは [ESM の実測表](esm-cache.ja.md#実測と再現)を参照してください。

Both columns use the same Rust release optimization and Binaryen 133; only `panic-details` differs. These are complete verification fixtures, including computation/formatting, deliberate panic/trap and hook/counter probe exports, **not** minimal runtime sizes or a reduction versus having no hook. JS is counted separately; see the [ESM measurement table](esm-cache.md#measurement-and-reproduction) for current shared-runtime sizes.

2026-10-19、Node.js 24 / V8 で測定。[全構成・入力ハッシュ / Full results and input hashes](panic-size.json)。
