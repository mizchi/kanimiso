# 実験環境の前提

2026-10-18 に Safari 27+ / JSPI 対応 V8 を設計の前提とする。実験的なプロダクトとして、新しい Wasm 機能の利用を優先する。

設計時に Safari 27.0 の JSPI 対応を [WebKit 公式](https://webkit.org/blog/18325/webkit-features-for-safari-27-0/#webassembly)で確認した。ユーザーから共有された[関連記事](https://daily.dev/posts/safari-27-brings-top-level-await-and-webassembly-jspi-to-all-browsers-ajkb9qiuh)も参照した。製品ランタイムは WebAssembly.promising / WebAssembly.Suspending を利用可能と仮定し、存在確認を挟まず直接呼び出す。未対応環境への互換フォールバックは提供しない。機能調査は検証ツールで行う。

手元の system JavaScriptCore は JSPI がなく、--useJSPI=true も認識しない。この環境は JSPI のテスト対象外であり、最新 Safari が非対応だという根拠にはしない。Safari 27 実ブラウザーは未実行で、公式の機能対応と生成物の動作検証を区別する。

`just check` は V8 で JSPI release/debug × std/no_std の共通3,507ケース、外から解決する二回の待機、実 Rust の線形スタックにデータを保持する16呼び出しを確認する。JS unit では reject/trap 後の first-fatal、待機キュー、dispose を確認する。検証ツールは JSC に必要な API があれば同じ実 Wasm テストを実行し、なければ前提外と記録する。

現在の checkout は `just browser-check` で Chrome 156 と Playwright WebKit 27.2 の E2E を通過した。2026-10-22 の方針として Playwright WebKit を Safari 向け検証の正式な代替とし、Safari 27+ の検証は完了とする。Safari.app の追加実行は完了条件に含めない。実行したエンジンは Playwright WebKit と記録する。[検証手順](development.ja.md)と[対応状況](status.ja.md)を参照。

JSPI scalar 構成は同期 WIT + Core Wasm を native Promise に接続する。既存 Future 構成の一般的な Rust Future / spawn_local / cancel と契約は異なる。同一 instance への entry は直列化し、host reject / Wasm trap は fatal とする。同期 WIT を JSPI で待機させることと、Component Model の native async ABI は別の構成として測る。

JSPI、exnref、funcref、GC、js-string、SIMD 等を利用してよいという方針であり、全機能を全ビルドで使用するという意味ではない。Kani/Miri の検証範囲も JSPI や JavaScript エンジン全体へ自動的に拡張されたとは扱わない。

2026-10-21 には Playwright 1.65.0-alpha-2026-10-21 / WebKit 27.2 revision 2380 の全13ケースを実行した。`just webkit-latest-check` は実行時点の nightly を分離して取得し、実際のエンジンと生成物のハッシュを記録する。[ブラウザー E2E](browser-testing.ja.md)を参照。

過去の計測 JSON の `safari_browser_verified: false` や `safari_app_verified: false` は、その計測で Safari.app を実行していないという記録であり、現在の Safari 対応の未完了を示すものではない。nightly の `engine.json` は `safari_validation.method` と `safari_validation.completed` に代替検証の方法と完了状態を記録する。
