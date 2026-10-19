# 開発・検証手順

[English](development.md) | 日本語

利用アプリの手順は[利用ガイド](guide.ja.md)を参照してください。リポジトリの開発には Node.js 24+、pnpm、Rust、just が必要です。

```sh
git clone https://github.com/mizchi/taraba.git
cd taraba
just setup
just check
```

setup は依存・Rust Wasm target・Binaryen 133・wasm-tools 1.245.1 を用意します。非同期サイズ比較では、別途 SHA 検証付きの wasm-bindgen CLI 0.2.129 を取得します。比較用 crate の Cargo.lock も保存します。

| タスク | 検証・出力 |
|---|---|
| `just msrv-check` | Rust 1.85.0 で native CLI と全 feature の Wasm ライブラリを確認。事前に toolchain と Wasm target を用意 |
| `just check` | Rust/JS、format、Core の fatal/所有権、JSPI stack spill、npm 利用側、現在のドキュメントリンク |
| `just library-check` | 現在の CLI から pack・外部 install・strict TS、3構成×std/no_std、raw/Cargo/watch の update 再生成と失敗時の保持、Component のドメイン値とエラー、Core の共通 ESM と instance 分離 |
| `just package-check` | 4 crate を package し、展開した CLI で外部アプリと npm 生成を再検証 |
| `just watch-check` | 実 Cargo/CLI の監視、workspace・feature・外部 path 依存、失敗後の復帰、出力除外、ビルド中の編集、Ctrl-C |
| `just panic-check` | Core の std/no_std × JSPI/Future、release/debug の panic 通知、通常の format/trap、hook 前の payload 整形。check にも含む |
| `just insight-check` | 整形マクロ警告、最適化後のサイズ・保持経路、通常版との共通ケース、npm からの解析除外と古い view の拒否 |
| `just compare-async-size` | Embassy / Tokio / async-executor / async-std / wasm-bindgen / FuturesUnordered と同じ同期・非同期処理をビルドし、日英の結果を更新 |
| `just analyze-wasm-size` | 共通 fixture を再ビルドし、twiggy の内訳・custom strip・memory packing・wasm-snip を負の対照込みで検証 |
| `just check-async-size` | 同じサイズ・正当性検証。出力は .cache/async-size のみ |
| `just compare-allocator` / `just check-allocator` | 変更前・現在の既定版/realloc feature・wee_alloc の共通 allocator 検査と9種類の V8 kernel 測定。check は .cache のみ |
| `just workers --jspi-concurrent` | 未採用の並行実験を含む既存 fixture を local workerd で実行 |
| `just modern` | js-string / GC / exnref / funcref の機能確認 |
| `just stress 60` | ランタイムの churn/所有権の stress |
| `just miri` / `just kani` | native64 の限定した runtime/allocator 部品とモデル |

レジストリ公開前の package-check は、依存を .crate 展開先へ patch します。アーカイブの内容と外部アプリのビルドを検証するもので、crates.io からのインストール成功とは区別します。npm/crates.io へ publish するタスクはありません。利用ガイドの registry コマンドは公開後の手順です。

ライブラリを手元で開発する場合は、registry 依存を checkout への path に替えます。
例: `taraba-helpers = { path = "../taraba/crates/taraba-helpers", features = ["strings"] }`。
4 crate の最低 Rust バージョンは 1.85 です。CI では開発用の固定 toolchain と別に
1.85.0 を使って検査します。

公開順序、clean なコミットの確認、registry 利用側の検証、npm のライセンスと
ソース案内は[リリース手順](releasing.ja.md)を参照してください。

unsafe な所有権・寿命を変えた場合は check / miri / kani / stress を実行します。native の部品証明は JS・V8/WebKit・生成 Wasm・intrusive WAT 全体や、比較に使う upstream executor の証明ではありません。JSPI と Component Canonical ABI は実行テストでも確認します。

通常の Kani タスクは realloc のワード分類・容量の判定を native64 の全有効サイズで
検証します。`just kani-explore` / `just kani-realloc-explore` のポインタ・データ・free list の証明は60秒の上限を超え、
未証明です。データ保持、新しい layout での解放、クラス変更、realloc 失敗時の保持は
Miri と実 Wasm の oracle で検査します。

Promise の Kani harness は製品の `JsFuture` / `JsValue` を読み込み、host モデル上で未 poll・待機中・完了後・消費後の Drop、成功・失敗・undefined、非ゼロの全 u32 subscription ID を検証します。Miri では外部 Waker の差し替えと ID 枯渇も検査します。JS や wasm32 のポインタの受け渡しは、この proof の対象外です。


`just helpers-check` は RegExp と機能別サイズのプローブ、std/no_std × JSPI/Future、キャンセル時の Drop、npm/TS を検証します。`just compare-helpers` で[結果](helpers.ja.md)を更新します。RegExp の Miri とモデル FFI を使う Kani proof も通常タスクに含まれます。

## 測定

[現在の scalar async サイズ比較](async-size.ja.md)は compare-async-size で再現します。全 Wasm/JS を計上し、型定義・container・tarball を分離し、ソースと成果物のハッシュを記録します。数値の出力前に共通 oracle を通します。性能の順位は測りません。同期対照には選んだバックエンドの公開 glue を含むため、async 増分と実行時合計は別の量です。

比較 fixture はこのリポジトリで完結し、wasm-battleground の checkout は不要です。公式 Embassy の WASM platform は std が必須で、no_std として扱いません。以前の raw Embassy + 独自ホストとは別の構成です。allocator の比較も別の対照実験に分けます。

過去の計時実験は次のコマンドで再実行できます。

```sh
just compare-wit
just experiment-jspi-future
just experiment-jspi-concurrent
```

これらは日時付きのスナップショットを更新します。check 版は過去の計測ドキュメントを書き換えずに fixture を検証します。並行 JSPI と Future adapter は未採用のまま、[採用条件](jspi-adoption.md)に従います。通常のビルドへ暗黙に組み込まないでください。

CI は製品・比較・package・modern・stress・workerd を実行し、verification artifact に library-check.json、async-size/check.json、package-check.json と従来の結果を保存します。ダウンロードした結果を checkout と照合する際は入力ハッシュを確認します。

[ドキュメント一覧](README.ja.md) · [ソースとライセンスの来歴](../THIRD_PARTY.md)。

`just strings-check` は正規化・分割・文字コードと型付き Iterator を検証します。`just compare-strings` で[サイズ表](strings.ja.md)を更新します。Miri/Kani には共通 Root と Iterator の所有権も含めます。
