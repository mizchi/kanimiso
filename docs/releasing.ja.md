# リリース手順

[English](releasing.md) | 日本語

publish は明示的なリリース依頼を受けて行います。以下は手順であり、自動公開タスクではありません。
4 crate、scaffold、埋め込みの通知、ドキュメントの版番号を揃えます。

CLI の互換系列内では private Rust/JS ABI を維持します。非互換の変更は 0.x なら minor、
0.0.x なら patch、1.0 以降は major を上げます。Cargo ビルドは runtime/helper crate の版を検査し、
raw Wasm の系列をまたぐ update はソースからの明示的な再ビルドを求めます。
private WIT の import の版も、その ABI に合わせて管理します。

`just check`、`just msrv-check`、`just package-check` を実行します。
unsafe・所有権を変えた場合は `just miri`、`just kani`、`just stress 60` も実行します。
リリース候補を commit・push し、その SHA の CI 成功を確認します。
clean なコミットで `just package-check --require-clean` を再実行し、各アーカイブの
`.cargo_vcs_info.json` が同じ SHA を示し、`dirty: true` がないことを確認します。
Safari 向け検証は `just browser-check` / `just webkit-latest-check` の WebKit E2E で完了とし、Safari.app の追加実行は要求しません。Miri/Kani は限定した native モデルの検証で、native Component host での実行は未検証です。

scaffold が全依存を取得できるよう、guest の3ライブラリを CLI より先に公開します。
guest は Cargo の検証にも Wasm target を指定し、CLI は native でビルドします。
まず次の各コマンドに `--dry-run` を付けて確認し、公開の明示的な承認後に外して実行します。

```sh
cargo publish --locked -p taraba --target wasm32-unknown-unknown
cargo publish --locked -p taraba-allocator --target wasm32-unknown-unknown
cargo publish --locked -p taraba-helpers --all-features --target wasm32-unknown-unknown
cargo publish --locked -p taraba-cli
```

crates.io に反映後、checkout の外の新しいディレクトリで CLI を registry からインストールします。

```sh
cargo install taraba-cli --version 0.2.1 --locked --root ./cli
./cli/bin/taraba new hello --no-std
cd hello
../cli/bin/taraba build
pnpm --dir pkg pack
```

std、`new --future` でも繰り返し、`taraba-helpers = { version = "0.2.1", features = ["strings"] }`
を追加したアプリも確認します。npm tarball を別アプリに install し、`AppBindings` / `AppHost`
の型検査、Wasm instantiate、生成メソッドの実行まで通します。
wasm-tools / jco を使う Component 経路も別途確認します。
Binaryen 133 などの準備は[導入手順](guide.ja.md)を参照してください。
registry の smoke test にはローカルの Cargo patch / path 依存を残しません。
公開前の archive ベースの package-check は、この確認とは区別します。

npm 公開や Wasm の配信前に `pkg/NOTICE.taraba`、`LICENSE.taraba`、
`LICENSE.taraba-allocator`、`UPSTREAM.taraba-allocator.json` を確認します。
ソースリンクは無改変の既定 allocator と memory_units 用です。
別版・改変版の MPL 対象ソースを使う場合は、配布物に対応するソースを提供し通知を更新します。
アプリ自身の package.json のライセンスは独立しています。他の依存の通知も別途確認します。
これらはパッケージのメタデータ量には加算され、実行する JS / Wasm の byte 数には含みません。
[ソースとライセンスの来歴](../THIRD_PARTY.md)も参照してください。

リリースタグは、検証済みコミットに対しリリース承認後に作成します。
公開した crate の版と registry smoke test の結果をリリースノートに記録します。
