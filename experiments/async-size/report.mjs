import { backends } from "./backends.mjs";
const names = Object.fromEntries(backends.map((b) => [b.id, b.name]));
const stdBackends = backends
  .filter((b) => b.modes.includes("std"))
  .map((b) => b.id);
const noStdBackends = backends
  .filter((b) => b.modes.includes("no_std"))
  .map((b) => b.id);
const n = (v) => v.toLocaleString("en-US");
const signed = (v) => `${v > 0 ? "+" : ""}${n(v)}`;
export function readmeEntries(r) {
  return ["jspi", "future-typed", "bindgen", "embassy", "wit-bindgen"].flatMap(
    (backend) =>
      ["std", "no_std"]
        .filter((mode) =>
          backends.find((b) => b.id === backend).modes.includes(mode),
        )
        .map((mode) =>
          r.entries.find(
            (e) =>
              e.backend === backend &&
              e.mode === mode &&
              e.allocator === "taraba" &&
              e.workload === "async",
          ),
        ),
  );
}
export function summary(r, lang) {
  const ja = lang === "ja";
  const kb = (v) => (v / 1000).toFixed(3);
  const lines = [
    ja
      ? "同じ二段の Promise 待機・加算を行う共通の Rust 実装で比較しています。各構成は同じ3,507ケースを通過。taraba-allocator（size classes 無効）を共通で使い、wasm-opt -Oz と JS minify を適用した非圧縮サイズです。1 kB = 1,000 bytes。"
      : "Each configuration compiles the same Rust implementation with two Promise waits and additions, and passes the same 3,507 cases. All use taraba-allocator with size classes disabled. Uncompressed sizes after wasm-opt -Oz and JS minification; 1 kB = 1,000 bytes.",
    "",
    ja
      ? "![std・no_std 別のサイズ比較。オレンジが Wasm、青が JS。同じ縮尺で taraba・wasm-bindgen-futures・Embassy・wit-bindgen async を比較。](docs/assets/async-size.svg)"
      : "![Size comparison by std and no_std. Orange is Wasm, blue is JS; taraba, wasm-bindgen-futures, Embassy and wit-bindgen async use the same scale.](docs/assets/async-size.svg)",
    "",
    "<details>",
    ja
      ? "<summary>数値を表で見る</summary>"
      : "<summary>View the numbers as a table</summary>",
    "",
    ja
      ? "| 構成 | Rust | Wasm kB | JS kB | 合計 kB |"
      : "| Configuration | Rust | Wasm kB | JS kB | Total kB |",
    "|---|---|---:|---:|---:|",
  ];
  for (const a of readmeEntries(r)) {
    lines.push(
      `| ${names[a.backend]} | ${a.mode} | ${kb(a.wasm_bytes)} | ${kb(a.js_bytes)} | **${kb(a.runtime.raw)}** |`,
    );
  }
  lines.push(
    "",
    "</details>",
    "",
    ja
      ? "taraba の JSPI はエンジンによる Promise 待機、Future は Rust の `async` / `.await` を使う構成です。`taraba build` が生成 Wasm から自動選択します。上のサンプルは Future 構成です。std が既定で、no_std の雛形は `taraba new hello --future --no-std` で作れます。"
      : "taraba JSPI uses engine-managed Promise waits; taraba Future runs Rust `async` / `.await`. `taraba build` detects the configuration from the compiled Wasm. The example above uses Future. std is the default; create a no_std scaffold with `taraba new hello --future --no-std`.",
    "",
    ja
      ? "wit-bindgen async は WIT の `async func` から Rust の `async fn` / Future を生成する標準 Component 構成です。不要な `async-spawn` は無効にし、JS 側で実行するための jco の接続コードも計上しています。"
      : "wit-bindgen async is the standard Component configuration: WIT `async func` generates Rust `async fn` / Futures. Unused `async-spawn` is disabled; totals include the jco bridge required to execute it in JavaScript.",
    "",
    ja
      ? "Embassy は公式の WASM event-loop integration と wasm-bindgen-futures の JsFuture を使用します。この構成は std をリンクするため、no_std の値は載せていません。表はアプリ全体のサイズです。JSPI は instance を直列実行し、各 executor の並行実行・エラー・タスク容量の契約は異なります。[全ランタイムの測定結果・圧縮・wee_alloc 対照・測定条件](docs/async-size.ja.md)。"
      : "Embassy uses its official WASM event-loop integration and wasm-bindgen-futures JsFuture. This configuration links std, so no no_std value is listed. These are whole application sizes. JSPI serializes an instance; executors differ in concurrency, errors and task capacity. See [all runtime measurements, compression, wee_alloc controls and methodology](docs/async-size.md).",
  );
  return lines.join("\n");
}
export function render(r, lang) {
  const ja = lang === "ja",
    async = (backend, mode, allocator = "taraba") =>
      r.entries.find(
        (e) =>
          e.backend === backend &&
          e.mode === mode &&
          e.allocator === allocator &&
          e.workload === "async",
      );
  const sync = (backend, mode, allocator = "taraba") =>
    r.entries.find(
      (e) =>
        e.backend === backend &&
        e.mode === mode &&
        e.allocator === allocator &&
        e.workload === "sync",
    );
  const lines = [
    ja ? "# 非同期処理のサイズ比較" : "# Async library size comparison",
    "",
    ja
      ? "[English](async-size.md) | 日本語"
      : "English | [日本語](async-size.ja.md)",
    "",
    r.created_at,
    "",
    ja
      ? "taraba・Embassy・wasm-bindgen-futures・wit-bindgen・Tokio・async-executor・async-std・FuturesUnordered をビルドし直した。同じ二段 await の Rust ソース、3,507 入力、全 I/O 引数、外から解決する二回の待機を検査した。以下は測定時点のスナップショットであり、固定されたライブラリ overhead や全用途での順位ではない。"
      : "Fresh builds of taraba, Embassy, wasm-bindgen-futures, wit-bindgen, Tokio, async-executor, async-std and FuturesUnordered. Every async build compiles the same two-await Rust source and passes 3,507 inputs, all I/O arguments and two externally controlled waits. These are dated application snapshots, not fixed library overhead or rankings for every workload.",
    "",
    ja
      ? "## std・同じ allocator で比べる"
      : "## Compare std with the same allocator",
    "",
    ja
      ? "すべて taraba-allocator の size classes 無効。同じ Rust / Binaryen と、同じ最終 JS minify・Wasm 最適化を使う。Wasm と JS の合計が実行時の配信サイズ。"
      : "All primary rows use taraba-allocator with size classes disabled, the same Rust/Binaryen, and identical final JS minification and Wasm optimization. Runtime distribution size is JS plus every required core Wasm.",
    "",
    ja
      ? "| 構成 | 同期合計 B | async Wasm B | async JS B | async 合計 B | 同期からの増分 B | Brotli 合計 B |"
      : "| Backend | Sync total B | Async Wasm B | Async JS B | Async total B | Growth B | Brotli total B |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  const row = (backend, mode, allocator = "taraba") => {
    const a = async(backend, mode, allocator),
      s = sync(backend, mode, allocator);
    return `| ${names[backend]} | ${n(s.runtime.raw)} | ${n(a.wasm_bytes)} | ${n(a.js_bytes)} | ${n(a.runtime.raw)} | ${signed(a.runtime.raw - s.runtime.raw)} | ${n(a.runtime.brotli)} |`;
  };
  for (const b of stdBackends) lines.push(row(b, "std"));
  lines.push(
    "",
    ja
      ? "## Rust Future: taraba と wit-bindgen"
      : "## Rust Futures: taraba and wit-bindgen",
    "",
    ja
      ? "両方とも同じ Rust の Future を駆動する。wit-bindgen は WIT `async func` と標準 Canonical ABI、taraba Future は WIT future<s32> から生成した型付き API を使い、内部では JS Promise と private resource ABI に変換する。wit-bindgen は必要な macros/async のみを有効にする。async-spawn を有効にした対照も別行に残し、その内部の FuturesUnordered の費用を最小構成と混ぜない。wit-bindgen 側は async func の処理であり、明示的な future<T> の受け渡しや spawn 操作は測っていない。"
      : "Both drive the same Rust Future. wit-bindgen uses WIT async func and the standard Canonical ABI; taraba Future uses typed bindings generated from WIT future<s32>, internally mapped to JS Promises and a private resource ABI. The minimal wit-bindgen configuration enables only macros/async. A separate async-spawn control retains its internal FuturesUnordered support. The wit-bindgen workload uses async func rather than explicit future<T> value transfers or spawn operations.",
    "",
    ja
      ? "| Rust | wit-bindgen Wasm B | taraba Future Wasm B | Wasm 削減率 | wit-bindgen Wasm + JS B | taraba Future Wasm + JS B |"
      : "| Rust | wit-bindgen Wasm B | taraba Future Wasm B | Wasm reduction | wit-bindgen Wasm + JS B | taraba Future Wasm + JS B |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const mode of ["std", "no_std"]) {
    const base = async("wit-bindgen", mode),
      small = async("future-typed", mode);
    lines.push(
      `| ${mode} | ${n(base.wasm_bytes)} | ${n(small.wasm_bytes)} | ${(100 * (1 - small.wasm_bytes / base.wasm_bytes)).toFixed(1)}% | ${n(base.runtime.raw)} | ${n(small.runtime.raw)} |`,
    );
  }
  lines.push(
    "",
    ja
      ? "合計には、wit-bindgen の Component を JavaScript から実行する jco の JS と全 core Wasm を含む。Component container は二重計上しない。標準 Canonical async ABI と Core の private Promise ABI の機能差も含む比較であり、差分全体を Rust executor の削減量とは扱わない。"
      : "Totals include the jco JavaScript and every core Wasm required to execute the wit-bindgen Component in JavaScript, without counting the Component container twice. Standard Canonical async ABI and the private Core Promise ABI have different capabilities; the full difference is not solely Rust executor savings.",
  );
  lines.push(
    "",
    ja
      ? "## 型付き Core async の追加サイズ"
      : "## Cost of typed Core async bindings",
    "",
    ja
      ? "同じ compute Future を同じ allocator・最適化条件で駆動する。手動で Promise handle を変換する従来版と、WIT から安全な import/Guest を生成する版を比較した。公開 WIT のカスタムセクションはビルド時に照合して削除する。標準 Component の future ABI を実装した値ではない。"
      : "Both versions drive the same compute Future with the same allocator and optimization settings. The control manually converts Promise handles; the typed version generates safe imports/Guest from WIT. Public WIT metadata is validated and stripped during the build. This is not an implementation of standard Component future ABI.",
    "",
    ja
      ? "| Rust | 手動 Wasm B | 型付き Wasm B | Wasm 増分 B | 手動 JS B | 型付き JS B | JS 増分 B |"
      : "| Rust | Manual Wasm B | Typed Wasm B | Wasm growth B | Manual JS B | Typed JS B | JS growth B |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const mode of ["std", "no_std"]) {
    const manual = async("future", mode),
      typed = async("future-typed", mode);
    lines.push(
      `| ${mode} | ${n(manual.wasm_bytes)} | ${n(typed.wasm_bytes)} | ${signed(typed.wasm_bytes - manual.wasm_bytes)} | ${n(manual.js_bytes)} | ${n(typed.js_bytes)} | ${signed(typed.js_bytes - manual.js_bytes)} |`,
    );
  }
  lines.push(
    "",
    ja
      ? "同じ std / allocator で、Embassy との差は次のとおり。負は taraba 側が小さいことを表す。"
      : "With the same std/allocator, these differences are relative to Embassy. Negative values mean the taraba configuration is smaller.",
    "",
    ja
      ? "| 構成 | async 合計 − Embassy B | 比率 |"
      : "| Backend | Async total − Embassy B | Ratio |",
    "|---|---:|---:|",
  );
  const embassy = async("embassy", "std");
  for (const b of stdBackends.filter((b) => b !== "embassy")) {
    const a = async(b, "std");
    lines.push(
      `| ${names[b]} | ${signed(a.runtime.raw - embassy.runtime.raw)} | ${(a.runtime.raw / embassy.runtime.raw).toFixed(3)}× |`,
    );
  }
  lines.push(
    "",
    ja
      ? "## 追加ランタイムと共有基盤からの増分"
      : "## Added schedulers and growth above the shared bridge",
    "",
    ja
      ? "追加構成は wasm-bindgen-futures の JsFuture と future_to_promise を共有し、そこに各 scheduler を載せる。次の差は同じ std/no_std・allocator の wasm-bindgen-futures 行との差で、接続コードと task/JoinHandle も含む。ライブラリ単体の固定費ではない。"
      : "The added profiles share wasm-bindgen-futures JsFuture and future_to_promise, then add their scheduler. Differences below use the wasm-bindgen-futures row with the same std/no_std and allocator, including bridge code and task/JoinHandle costs. They are not fixed library overhead.",
    "",
    ja
      ? "| 構成 | mode | 追加 Wasm B | 追加 JS B | 追加合計 B |"
      : "| Backend | Mode | Extra Wasm B | Extra JS B | Extra total B |",
    "|---|---|---:|---:|---:|",
  );
  for (const e of r.entries.filter(
    (e) =>
      ["tokio", "async-executor", "async-std", "futures-unordered"].includes(
        e.backend,
      ) &&
      e.workload === "async" &&
      e.allocator === "taraba",
  )) {
    const base = async("bindgen", e.mode);
    lines.push(
      `| ${names[e.backend]} | ${e.mode} | ${signed(e.wasm_bytes - base.wasm_bytes)} | ${signed(e.js_bytes - base.js_bytes)} | ${signed(e.runtime.raw - base.runtime.raw)} |`,
    );
  }
  lines.push(
    "",
    ja
      ? "- **Tokio**: `rt` のみ。instance ごとに current-thread Runtime と LocalSet を一つ持ち、compute を spawn_local して JoinHandle を待つ。独自の JS 接続が、各 wake で直ちに Ready を返す root の block_on 内から LocalSet を一度 poll する。JS スレッドを park せず、次の JS wake で再開する。接続コードも計上し、timer/net/multithread は含めない。[Tokio の WASM 制約](https://docs.rs/tokio/latest/tokio/#wasm-support)、[LocalSet](https://docs.rs/tokio/latest/tokio/task/struct.LocalSet.html)。\n- **async-executor**: instance ごとに LocalExecutor を一つ持ち、永続する wasm-bindgen の driver が run(pending) を駆動する。spawn した compute の Task を待つ。smol の I/O reactor 全体を測る構成ではない。[LocalExecutor](https://docs.rs/async-executor/latest/async_executor/struct.LocalExecutor.html)。\n- **async-std**: default features と unstable の spawn_local を使用。Wasm 実装は wasm-bindgen-futures と channel の JoinHandle を使う。[API](https://docs.rs/async-std/latest/async_std/task/fn.spawn_local.html)。[開発終了済み](https://github.com/async-rs/async-std)のため、既存コードとの比較用に含めた。\n- **FuturesUnordered**: 1呼び出しにつき compute 一件を入れ、StreamExt::next を待つ。単独の runtime や spawn API を持たないタスク集合の参考値であり、常駐する executor と同じ機能ではない。[API](https://docs.rs/futures-util/latest/futures_util/stream/struct.FuturesUnordered.html)。"
      : "- **Tokio**: rt only, one current-thread Runtime and LocalSet per instance; spawn_local schedules compute and its JoinHandle is awaited. A custom JS adapter polls LocalSet once inside a block_on whose root immediately returns Ready on each wake. This avoids parking the JS thread; the next JS wake resumes it. The adapter is counted; timer/net/multithread are disabled. [WASM limits](https://docs.rs/tokio/latest/tokio/#wasm-support), [LocalSet](https://docs.rs/tokio/latest/tokio/task/struct.LocalSet.html).\n- **async-executor**: one LocalExecutor per instance, with a persistent wasm-bindgen driver awaiting run(pending). The spawned compute Task is joined. This does not measure the full smol I/O reactor. [LocalExecutor](https://docs.rs/async-executor/latest/async_executor/struct.LocalExecutor.html).\n- **async-std**: default features plus unstable spawn_local; the WASM implementation uses wasm-bindgen-futures and a channel JoinHandle. [API](https://docs.rs/async-std/latest/async_std/task/fn.spawn_local.html). The project is [discontinued](https://github.com/async-rs/async-std) and is included for existing-code comparisons.\n- **FuturesUnordered**: a per-invocation collection containing one compute Future, awaited with StreamExt::next. It is a task-collection reference without an independent runtime or spawn API; its capabilities differ from a persistent executor. [API](https://docs.rs/futures-util/latest/futures_util/stream/struct.FuturesUnordered.html).",
  );
  lines.push(
    "",
    ja ? "## no_std の比較" : "## no_std comparison",
    "",
    ja
      ? "Embassy の公式 platform-wasm、Tokio、async-executor、async-std の今回の構成は std をリンクするため、no_std 値は作らない。no_std の raw Embassy + 独自ホストという別構成はここでは測っていない。[Embassy の cfg](https://docs.rs/crate/embassy-executor/0.10.0/source/src/lib.rs)も参照。FuturesUnordered は alloc を使うタスク集合として no_std も測る。"
      : "The selected official Embassy WASM platform, Tokio, async-executor and async-std configurations link std; no no_std values are invented. A raw no_std Embassy executor with a custom host is a different, unmeasured profile; see [Embassy cfg](https://docs.rs/crate/embassy-executor/0.10.0/source/src/lib.rs). FuturesUnordered is also measured as an alloc-based no_std task collection.",
    "",
    ja
      ? "| 構成 | 同期合計 B | async Wasm B | async JS B | async 合計 B | 同期からの増分 B | Brotli 合計 B |"
      : "| Backend | Sync total B | Async Wasm B | Async JS B | Async total B | Growth B | Brotli total B |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const b of noStdBackends) lines.push(row(b, "no_std"));
  lines.push(
    "",
    ja ? "### std で増えた Wasm" : "### Wasm added by std",
    "",
    ja
      ? "この表は std のリンクによる Wasm の増分を示す。JS の変化は実行時合計に別途計上する。no_std の panic は unreachable、std は標準 panic 経路という構成差も含み、増分全体を task scheduler のサイズとは扱わない。"
      : "This table isolates Wasm growth from linking std; any JS changes are counted separately in runtime totals. no_std traps on panic whereas std uses the standard panic path; the entire difference is not scheduler overhead.",
    "",
    ja
      ? "| 構成 | no_std async Wasm B | std async Wasm B | std − no_std B |"
      : "| Backend | no_std async Wasm B | std async Wasm B | std − no_std B |",
    "|---|---:|---:|---:|",
  );
  for (const b of noStdBackends) {
    const a = async(b, "no_std"),
      s = async(b, "std");
    lines.push(
      `| ${names[b]} | ${n(a.wasm_bytes)} | ${n(s.wasm_bytes)} | ${signed(s.wasm_bytes - a.wasm_bytes)} |`,
    );
  }
  lines.push(
    "",
    ja ? "## 増分の読み方" : "## Interpret the growth correctly",
    "",
    ja
      ? "同期版も `add(a,b)` → `add(first,1)` を同じ順で実行する。それぞれのバックエンドの公開 JS API を含むので、すでにリンクした固定費は同期側にも計上される。素の WebAssembly に全 async 機能を追加したコストとは異なる。"
      : "The sync control performs add(a,b), then add(first,1), in the same order. Each backend's public JS API is included, so prelinked fixed costs already appear in its sync control. This is not the entire cost of adding all async capabilities to bare WebAssembly.",
    "",
    ja
      ? "- JSPI は同期版・async 版とも同じ Promise host を使う。Rust Future は host import 内で suspend し、poll は Ready を返す。測定では JS のサイズは同じでも、同期の関数と Rust Future のコード生成差が Wasm に残った。エンジンの JSPI 実装や suspended stack memory は配信サイズに含まれない。\n- taraba Future の同期版にも既存ホスト全体を含む。async の増分とホストの固定費は別。\n- Component は typed WIT async / Canonical ABI と jco scheduler を含む。この scalar workload は record 等の汎用性を使っていない。\n- Embassy は公式の WASM event-loop integration、JsFuture、型付き worker ×1,024 を使う。固定 pool の予約メモリと配信 Wasm bytes は別で、任意サイズの Future を動的 spawn する API と同じ契約ではない。"
      : "- JSPI uses the same Promise host in both controls. The Rust Future suspends inside the host import and returns Ready from poll. JS bytes stay equal here, while the difference between a direct function and Rust Future code generation remains in Wasm. Engine implementation and suspended-stack memory are outside transmitted bytes.\n- taraba Future's synchronous control already includes the existing host. Incremental async bytes and fixed host bytes are different.\n- Component includes typed WIT async, Canonical ABI and the jco scheduler. This scalar workload does not exercise records or its other general types.\n- Embassy uses the official WASM event-loop integration, JsFuture and 1,024 statically allocated typed workers. Reserved pool memory differs from transmitted Wasm bytes; this is not the same API as dynamically spawning arbitrary-size Futures.",
    "",
    ja
      ? "## allocator を揃えた理由・wee_alloc 対照"
      : "## Allocator control: wee_alloc",
    "",
    ja
      ? "次の表だけ allocator を wee_alloc 0.4.5 に変更し、size classes はどちらも無効にした。差は allocator とその呼び出し元の最適化を含み、executor の変更ではない。"
      : "Only the following control switches the allocator to wee_alloc 0.4.5; size classes are disabled in both. Differences include allocator/caller optimization, not a different executor.",
    "",
    ja
      ? "| 構成 | モード | taraba-allocator 合計 B | wee_alloc 合計 B | wee − taraba B |"
      : "| Backend | Mode | taraba-allocator total B | wee_alloc total B | wee − taraba B |",
    "|---|---|---:|---:|---:|",
  );
  for (const [b, m] of [
    ["bindgen", "no_std"],
    ["bindgen", "std"],
    ["embassy", "std"],
  ]) {
    const a = async(b, m),
      w = async(b, m, "wee");
    lines.push(
      `| ${names[b]} | ${m} | ${n(a.runtime.raw)} | ${n(w.runtime.raw)} | ${signed(w.runtime.raw - a.runtime.raw)} |`,
    );
  }
  lines.push(
    "",
    ja ? "## npm と Component の配布物" : "## npm and Component payloads",
    "",
    ja
      ? "実行時サイズには型定義と Component container を足さない。npm tarball はそれらも含む別の配布量で、gzip 圧縮と package metadata の影響も受ける。Component 本体を別 entry として配布すると、展開済み core と container を両方 pack する。"
      : "Declarations and the Component container are excluded from runtime download size. npm tarballs include those separate distribution payloads and gzip/package metadata. Shipping the Component as a separate entry packs both the container and its extracted cores.",
    "",
    ja
      ? "| 構成・モード | 型定義 B | Component B | npm tgz B |"
      : "| Backend / mode | Declarations B | Component B | npm tgz B |",
    "|---|---:|---:|---:|",
  );
  for (const e of r.entries.filter(
    (e) => e.workload === "async" && e.allocator === "taraba",
  ))
    lines.push(
      `| ${names[e.backend]} / ${e.mode} | ${n(e.declaration_bytes)} | ${n(e.component_bytes)} | ${n(e.npm_tarball_bytes)} |`,
    );
  lines.push(
    "",
    ja
      ? "taraba の実用ガイドは [使い方](guide.ja.md)。型付き Core Future は WIT future<s32> から Promise<number> を生成する。従来の opaque resource は unknown のまま。Component は標準の型付き async ABI を使う。wasm-bindgen の公式生成型も保存しており、この比較の Rust→JS Promise 戻り値には any が含まれる。"
      : "See the [usage guide](guide.md). Typed Core Future generates Promise<number> from WIT future<s32>; legacy opaque resources remain unknown. Component uses the standard typed async ABI. The official wasm-bindgen declarations are retained and include any for this Rust-to-JS Promise result.",
    "",
    ja ? "## 検証・条件・再実行" : "## Verification and reproduction",
    "",
    `${r.engine}; ${r.versions.rust}; Binaryen ${r.versions.binaryen}; wasm-bindgen ${r.versions.wasm_bindgen}; wasm-bindgen-futures ${r.versions.wasm_bindgen_futures}; js-sys ${r.versions.js_sys}; wit-bindgen ${r.versions.wit_bindgen}; Embassy ${r.versions.embassy_executor}; Tokio ${r.versions.tokio}; async-executor ${r.versions.async_executor}; async-std ${r.versions.async_std}; futures-util ${r.versions.futures_util}; jco ${r.versions.jco}; Rolldown ${r.versions.rolldown}.`,
    "",
    ja
      ? `npm pack から展開した全${r.entries.length}成果物で同じ3,507ケースと strict TS を通した。async ${r.entries.filter((e) => e.workload === "async").length}成果物では二回の外部制御待機も確認。Core JSPI の直列実行とその他の独立タスク進行を別々に検査した。追加ランタイムと Embassy の開始順は FIFO と仮定していない。Embassy の 1,025 件投入は 1,024 件成功・超過1件だけ reject、その後の pool 再利用も成功した。キャンセル・Drop・fatal・JS オブジェクト同一性が全方式で等しいとの主張はしていない。`
      : `All ${r.entries.length} artifacts extracted from npm pack pass the same 3,507 cases and strict TypeScript. All ${r.entries.filter((e) => e.workload === "async").length} async artifacts also pass two externally controlled waits. Core JSPI serialization and independent progress in other backends are checked separately; added runtimes and Embassy are not assumed FIFO. Embassy admits 1,024 pending jobs, rejects only the 1,025th and then reuses its pool. Cancellation, Drop, fatal handling and JS object identity are not claimed equivalent.`,
    "",
    ja
      ? `wasm-bindgen 系の async ${r.entries.filter((e) => e.failure_recovery).length}成果物では、一回目・二回目それぞれの await の Promise 拒否、拒否オブジェクトの同一性、並行する別タスクの成功、その後の再利用も検査した。JSPI / Core Future / Component のエラー契約とは分けている。`
      : `The ${r.entries.filter((e) => e.failure_recovery).length} wasm-bindgen-based async artifacts additionally check Promise rejection at each await, rejection-object identity, success of an independent task, and subsequent executor reuse. JSPI/Core Future/Component error contracts are separate.`,
    "",
    ja
      ? "計時は行わず、サイズのみ測定。V8 で実行し、Safari 実機・native Component host・JS heap / suspended stack memory は未測定。no_std 行は std feature を無効にし、アプリが panic handler を定義してビルドした。Embassy の公式 WASM platform は std 必須として別扱い。"
      : "No performance ranking is measured here. Execution uses V8; Safari hardware, native Component hosts, JS heap and suspended-stack memory are unmeasured. no_std rows disable std features and define the application panic handler. The official Embassy WASM platform's required std is explicitly separate.",
    "",
    "```sh",
    "just compare-async-size  # rebuild, verify, write this snapshot",
    "just check-async-size    # same verification, .cache output only",
    "```",
    "",
    ja
      ? "全ファイルの raw/gzip/Brotli、同期→async の Wasm / JS 別増分、全入力ソースの SHA は [JSON](async-size.json)。過去の抽出前の数値は流用していない。"
      : "Per-file raw/gzip/Brotli, separate Wasm/JS growth, and input SHA hashes are in [JSON](async-size.json). No pre-extraction measurements are reused.",
    "",
  );
  return lines.join("\n");
}
