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
- WIT native async / Canonical ABI は `--component`。Core は既定で `pkg/index.js`・`index.d.ts`・`package.json` を生成し、npm の名前・版・ライセンスは Cargo metadata から継承する。`--npm-name` 等で上書きできる。Component の npm 出力は `--npm-name` を指定する。標準 Component の型・async ABI を独自に置換せず wit-bindgen / jco に委ねる。Core の opaque Promise payload は TS でも unknown とする。
- ライブラリの変更は `just library-check` / `just package-check` で pack・別アプリへの install・strict TS・共通実装を確認する。Component validate は native host 実行の証拠とは扱わない。
- release の JS エラーはコードと docs/error-codes.md への URL に揃え、説明辞書を生成物に同梱しない。debug の説明はビルド時に分離する。外部例外の identity/message は維持する。
- Core の公開 export は createHost のみ。標準 Wasm instantiate → attach → 型付き host.method を使う。共有ランタイムの呼び出し口は call に集約し、promise や root/get/take/release の host 別名を増やさない。imports.jsrt は Wasm 接続専用。Component の jco instantiate は別契約として維持する。
