# Development

- ユーザーには日本語で答える。
- TDD: 探索 → Red → Green → Refactoring。
- タスクは justfile、Node.js 24+ と pnpm を使う。
- API・ABI と実装を分離し、ABI の所有権を明示する。
- 変更時は `just check`。unsafe/寿命の変更では `just miri`、`just kani`、`just stress 60` も確認する。
- Kani は native 64-bit の限定された部品・モデルの検証。JS/V8/WebKit、Wasm コード生成、intrusive WAT 全体の証明として扱わない。
- `crates/kanimiso-allocator` の MPL-2.0 と来歴を維持する。
- 実験環境の前提は Safari 27+ / JSPI 対応 V8。古い system JSC の未対応を最新 Safari の非対応と扱わない。Safari 実ブラウザーを実行していなければ未検証と明記する。
- JSPI scalar profile は同一 instance の guest entry を直列化し、host reject / Wasm trap で instance を閉じる。既存の Future/cancel 契約と同一視しない。
- npm/crates.io 公開は別の明示的な依頼があるまで行わない。
