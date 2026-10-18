# 抽出時の検証

2026-10-18T11:52:36.935Z / Node v24.21.0 / V8 13.6.233.17-node.53

## サイズ

| 構成 | Wasm B | JS host B | Wasm + host B | loader を含む B |
|---|---:|---:|---:|---:|
| release/no_std | 1414 | 3672 | 5086 | 5288 |
| release/std | 6687 | 3672 | 10359 | 10561 |
| debug/no_std | 1414 | 4172 | 5586 | 5786 |
| debug/std | 6687 | 4172 | 10859 | 11059 |

Wasm は二段 await の最小サンプル。runtime 単体の固定費ではない。アプリの Future 等を含む。
汎用 bindings と loader を追加したため、元の 4,950 B を流用していない。
std のパス文字列は移動で変わるため、元とのサイズ差全体を最適化効果とはみなさない。

## 確認結果

- `just check`: release/debug × std/no_std。各構成で同じ計算、22 回帰、9 異常終了、storage/capacity、10,000 step fuzz。Node unit と native Rust も通過。
- `just stress 60`: 60.11 秒、417 seeds、834 runs、8,340,000 steps。同じ seed の std/no_std の観測値が一致し、memory は 256 KiB。
- `just miri`: runtime std/no_std 各3件、allocator 8件、extra assertions を有効にした merge 2件の計16件。
- `just kani`: ID モデル2件、実装 Waker 1件、allocator 境界3件の計6 proof。
- `just workers`: local workerd、release/debug × std/no_std の4構成。各3507タスク、追加20チェック、JS roots の解放。Cloudflare本番未deploy。
- `just modern`: V8 と system JavaScriptCore で js-string / exnref / typed funcref / GC と現行 std/no_std の同一計算が通過。

Safari 実ブラウザーは未検証。JavaScriptCore shell では HTML の queueMicrotask を Promise ジョブで補う。
Kani は native 64-bit と mock backend の部品検証。JS / engine / Wasm layout / intrusive WAT 全体の形式証明ではない。
複数 live allocation と隣接 free 結合の探索的 proof は広い条件での実行が時間切れとなり、証明済み数に含めない。
必要なら `just kani-explore` で別途確認する。Miri/native/実 Wasm の対応テストは通過。

入力 SHA-256 と機械可読の集計は [verification.json](verification.json)。
元ファイルの来歴は [provenance.json](../provenance.json)。生のログはローカルの .cache にある。
