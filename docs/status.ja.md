# 現在の対応状況と制限

[English](status.md) | 日本語

このページは 0.2.1 の対応状況です。resource の instance method と Rust 実装の exported resource を含みます。0.1.0 から更新する場合は CLI と Rust crate の依存を両方更新し、`pkg/` を再生成してください。[インストール手順](guide.ja.md#インストール)を参照してください。

## 実行方式を選ぶ

| 必要なもの | Core/JSPI | Core Future | Component |
|---|---|---|---|
| 小さな数値の境界 | 既定。s32/u32/f64/void | 対応 | 対応 |
| WIT の string・record・list などの値型 | 未対応 | world・interface の同期・非同期関数に対応 | 標準 wit-bindgen binding |
| Rust の `.await`・独立した task・`spawn_local` | Future executor なし。同期形の guest 呼び出しを JSPI が停止 | 対応 | Component toolchain の async 実装 |
| 非同期関数での imported opaque resource の own/borrow | 未対応 | freestanding 関数に対応 | 標準 resource binding |
| imported resource の constructor | 未対応 | interface alias ごとの型付き factory | 標準 resource binding |
| resource の instance method・Rust 実装の exported resource | 未対応 | 型付き constructor・同期/非同期 method・own/borrow | 標準 resource binding |
| 呼び出し単位のキャンセル | 未対応 | JoinHandle / host.cancel、任意の `--abort-signal` | upstream の契約。Core とは異なる |
| host の終了処理 | `host.dispose()` | `host.dispose()` | upstream の寿命管理。Core host API は対象外 |
| 標準 Canonical ABI・native WIT async | 未対応 | 未対応。独自の JS ABI | `--component` |
| JS・TS 付き npm ライブラリ | 既定で `pkg/` を出力 | 既定で `pkg/` を出力 | `--component --npm-name ...` |

`taraba build` は生成 Wasm のランタイム import/export と WIT の要件から JSPI/Future を判定します。ソースの `async` キーワードでは判定しません。標準 Component は明示して選びます。Core の生成物は標準 WebAssembly API でロードでき、jco は不要です。Component の npm 生成には jco を使います。

JSPI は host I/O の待機中も instance ごとのキューを保持します。host callback から同じ instance への再入を await すると進行できません。host の reject または Wasm trap は instance を閉じます。dispose は呼び出し元の Promise を直ちに reject しますが、停止中の stack は元の I/O が完了するまでエンジンが保持します。Rust Drop や I/O の abort を強制するものではありません。

Future は I/O 待機中も別の呼び出しを進められます。終了時は task をキャンセルし、subscription・JS root・provider の参照を解放します。`--abort-signal` を使うと協調する host I/O にもキャンセルを伝えます。任意の Promise を中止できるわけではありません。小さな task は 128 B の slot に置き、大きい・alignment の大きい task は Box に pin します。`--task-slots` で容量を変更でき、pool 枯渇やヒープ OOM は fatal です。[Core の契約](core-runtime.ja.md)と[型付きの終了処理の例](typescript.ja.md)を参照してください。

## TS の型とヘルパー

Core Future は各幅の数値（64-bit 整数は bigint）、bool、char、string、list、tuple、record、option、result、variant、enum、flags、型エイリアスに対応します。WIT の名前付き型を TS に export し、readonly な入力を受け付け、数値 list は TypedArray にします。戻り値を含めて文字列・list はコピーで受け渡し、Wasm memory の view は貸し出しません。WIT Result のエラーと、外部 Promise の reject は区別します。

Core Future は imported resource の method と Rust 実装の exported resource の constructor・method に対応します。戻り値や入れ子の borrow、resource の static method、Rust resource を host import に渡す構成、stream、入れ子の future、固定長 list は未対応です。Component は upstream の binding を使い、Core のテストで Component のすべての提案への対応を確認したとは扱いません。[TS との疎通](typescript.ja.md)に詳細があります。

`taraba-helpers` は JS の RegExp（コンパイル・判定）、文字列・Unicode 操作、Intl.Segmenter、非ストリーミングの TextDecoder を借用します。Iterator の接続は同期 JS Iterator → Rust Iterator で、途中 Drop 時に close します。AsyncIterator、Rust Iterator → JS、URLPattern、汎用 Map・Date・HTTP wrapper は未実装です。Core の追加 JS は使う操作と共通基盤だけです。[ヘルパー](helpers.ja.md)と[文字列](strings.ja.md)を参照してください。

## 配布とランタイムの範囲

生成する `pkg/` は entry・TS 型・Wasm・ランタイム・WIT・npm metadata を含み、単体で pack できます。JS アセットは CLI に同梱するため、別の npm ランタイム依存は不要です。`build --watch`・`update`・`insight` を使えます。build や update は publish しません。

Core のビルドは Cargo のバージョン互換性に加え、生の Wasm にある Rust runtime の ABI revision を検査します。欠落・不一致・不正・重複した metadata は最適化前に拒否します。受理した revision は `build.json` に記録し、配布 Wasm から marker を削除します。古い raw Wasm は、対応する runtime と CLI で再ビルドしてください。

JS ランタイムを共有するには、同一内容を同じ realm 内の同じ ESM URL に解決します。既定のパッケージ別のパスには[明示的な集約](esm-cache.ja.md)が必要です。instance の状態と memory は個別に持ちます。現在の[数値 async のサイズ](async-size.ja.md)、[複合型 async の比較](rich-async-size.ja.md)、[最適化の結果](bundle-tuning.ja.md)は Wasm と JS を分けて計上しています。

Core は単一の JS agent 向けで、共有 memory は拒否します。`taraba-allocator` は wee_alloc 由来で、マルチスレッド向けではありません。JSPI・GC など最新 Wasm 機能を許容することと、Rust のヒープを Wasm GC に載せることは別です。WASI3 host・WASI 実装・Preview 1 adapter・HTTP server・汎用 FFI generator は内蔵せず、アプリの I/O は WIT の host callback で渡します。JSPI Future adapter と stack snapshot による並行バックエンドは未採用の実験です。

## 検証できている範囲

| 対象 | 根拠と限界 |
|---|---|
| Node/V8・ブラウザー動作 | ローカルの Rust/JS、pack/install、strict TS に加え、Chrome 156・Playwright WebKit 27.2 の E2E を通過 |
| Safari 27+ | 完了。Playwright WebKit を Safari 向け検証の代替として採用。Safari.app の追加実行は不要 |
| Cloudflare Workers | 既存 fixture を local workerd で実行。本番へのデプロイは未検証 |
| Component | jco 実行と component validate。native Component host での実行は未検証 |
| メモリ・所有権 | Miri・native64 の限定した Kani モデル・stress。JS エンジン・生成 Wasm・ABI 全体の証明ではない |
| GitHub Actions | workflow にジョブを設定。ローカルの成功だけで、そのコミットの Actions 通過とは扱わない |

再現コマンドは[開発・検証手順](development.ja.md)、公開前の確認は[リリース手順](releasing.ja.md)にあります。

[Core resource の実装例と制約](resources.ja.md)。method / Rust resource は CLI と Rust runtime の両方で 0.2.1 以降が必要です。

ブラウザー E2E は [安定版26ケース・最新 nightly WebKit13ケース](browser-testing.ja.md)を通過しました。nightly の実際の版・build・テスト結果は実行ごとに記録します。
