# Development

- ユーザーには日本語で答える。
- TDD: 探索 → Red → Green → Refactoring。
- タスクは justfile、Node.js 24+ と pnpm を使う。
- API・ABI と実装を分離し、ABI の所有権を明示する。
- 変更時は `just check`。unsafe/寿命の変更では `just miri`、`just kani`、`just stress 60` も確認する。
- Kani は native 64-bit の限定された部品・モデルの検証。JS/V8/WebKit、Wasm コード生成、intrusive WAT 全体の証明として扱わない。
- `crates/taraba-allocator` の MPL-2.0 と来歴を維持する。
- 実験環境の前提は Safari 27+ / JSPI 対応 V8。古い system JSC の未対応を最新 Safari の非対応と扱わない。Safari 実ブラウザーを実行していなければ未検証と明記する。
- CLI の new は JSPI が既定。build は Cargo プロジェクトをビルドし、Core は生成 Wasm の jsrt/pool import・rt_* export と WIT resource の要否から JSPI/Future を自動選択する。明示した --jspi/--future は上書き、Component は配布形式として --component を指定する。Rust ソース中の async/Future キーワードでは判定しない。JSPI Future アダプターは実験扱いを維持し、削除条件は `docs/jspi-adoption.md` に従う。
- 製品・実験用の JSPI ランタイムは対応済みエンジンを前提とし、WebAssembly.promising / Suspending の存在チェックを入れない。エンジン機能の調査は検証ツールで行う。
- WIT と生成 TS 型で確定する関数・bindings の型はランタイムで再検証しない。JSPI の接続対象はビルド時に生成する。Core の shared memory はビルド時に拒否し、JS の SharedArrayBuffer 有無は調べない。attach/fatal・所有権・タスク状態の不変条件は実行時に扱う。
- JSPI scalar profile は同一 instance の guest entry を直列化し、host reject / Wasm trap で instance を閉じる。既存の Future/cancel 契約と同一視しない。
- 同一 instance の並行 JSPI は `experiments/jspi-concurrent` の未採用実験。snapshot の復元は JSPI 再開後の同期 Wasm trampoline で行い、Promise reaction から復元しない。製品へ暗黙に適用しない。
- npm/crates.io 公開は別の明示的な依頼があるまで行わない。
- 標準 WIT native async / Canonical ABI は `--component`。Core は world 直下と WIT interface の値型（数値・bool・char・string・list・option・result・tuple・record・variant・enum・flags）の `future<T>` / `future` と同等の `async func` から安全な Rust/TS API を生成できるが、既存の private Promise/resource ABI に変換する構成であり、標準 Component async/future ABI とは同一視しない。Core の imported opaque resource は freestanding 関数の own/borrow と typed async に対応する。Core の imported resource constructor は interface ごとの型付き factory として対応する（Rust imports::io::value / JS bindings.io.value）。resource method と Rust-defined exported resource は Component を使う。Core は既定で `pkg/index.js`・`index.d.ts`・`package.json` を生成し、npm の名前・版・ライセンスは Cargo metadata から継承する。`--npm-name` 等で上書きできる。Component の npm 出力は `--npm-name` を指定する。標準 Component の型・async ABI を独自に置換せず wit-bindgen / jco に委ねる。Core の opaque Promise payload は TS でも unknown とする。
- ライブラリの変更は `just library-check` / `just package-check` で pack・別アプリへの install・strict TS・共通実装を確認する。Component validate は native host 実行の証拠とは扱わない。
- release の JS エラーはコードと docs/error-codes.md への URL に揃え、説明辞書を生成物に同梱しない。debug の説明はビルド時に分離する。外部例外の identity/message は維持する。
- Core の公開 export は createHost のみ。標準 Wasm instantiate → attach → 型付き host.method を使う。共有ランタイムの呼び出し口は call に集約し、promise や root/get/take/release の host 別名を増やさない。imports.jsrt は Wasm 接続専用。Component の jco instantiate は別契約として維持する。

- Core の値型 codec は WIT から生成し、最適化済み Wasm に残る import の実装だけをアプリの index.js に含める。共有 runtime に型別の実装を入れない。未使用の型・import による配布サイズ増分 0 B を `just core-types-check` で検証する。

- Core の TS binding は名前付き WIT 型を type export し、WitInput<T> で readonly 入力を受け付ける。数値 list は TypedArray を両方向にコピーする。単純な option は T | undefined、record では optional フィールド、末尾の引数は省略可。入れ子の option は外側のタグを維持する。WIT result のドメインエラーと Promise reject の identity は区別する。docs/typescript.{md,ja.md} のサンプルを npm pack/install と NodeNext/bundler の厳しい設定で検証する。

- Core の Rust runtime ABI revision は SemVer と独立に検査し、古い・不正・重複した raw Wasm をビルド時に拒否する。ABI metadata は配布 Wasm から削除する。互換性を壊す private ABI 変更時は Rust/CLI 両方の revision と回帰テストを更新する。
