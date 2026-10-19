# Inspect Wasm size

English | [日本語](insight.ja.md)

`taraba build` warns about formatting macros and formatting functions in Wasm. Use `taraba insight` to inspect large optimized functions and their keeping paths. Analysis runs in the native CLI, without linking its libraries into guest Wasm or JS.

```sh
taraba build --insight
taraba insight
taraba insight --paths fmt
taraba insight --retained --top 10
taraba insight --json > sizes.json
```

## Build warnings

`taraba::host-builtin` also reports selected normal Cargo dependencies before compilation. See [helper candidates and measured probes](helpers.md). It does not infer retained bytes from dependency presence.

| Warning | Meaning |
|---|---|
| `taraba::fmt-size` | Finds `format!`, `write!`, `writeln!`, print macros, `format_args!`, `dbg!` or `fmt!`; reports file, line and column |
| `taraba::fmt-linked` | Finds named formatting functions in input Wasm; reports count and encoded bytes before wasm-opt |

These are candidates, not measured incremental costs or predicted savings. `format_args!` alone need not link all formatting machinery, and unused code can disappear.

Source detection uses Cargo dep-info and syntax trees within the selected library's source directory. It ignores comments/strings and handles common test, feature and debug-assertion cfgs. It does not expand macros, resolve aliases or fully evaluate `cfg_attr`; unused functions and custom macros with matching names can produce candidates. Inspect dependency formatting on the Wasm side.

With a `.wasm` input, only Wasm diagnostics run. Stripped or inlined code may not be identifiable by name; no warning does not prove formatting is absent. `taraba build --no-size-warnings` suppresses these hints, preserving ordinary compiler warnings.

## Analysis and distribution files

Core `--insight` preserves names during optimization and produces:

| File | Purpose |
|---|---|
| `pkg/app.wasm` | Distribution artifact, with function-name metadata removed |
| `pkg/.taraba/insight.wasm` | Optimized named view, without DWARF |
| `pkg/.taraba/insight.json` | All functions and their size/retention summary |

Removing only name metadata from the view yields exactly the corresponding `app.wasm`. Directory inspections verify this equality and reject stale views. Preserving names can change Binaryen's index ordering; a separate ordinary build is not guaranteed byte-identical.

```sh
taraba build --insight --npm-name @example/library
pnpm --dir pkg pack
```

`.taraba/` remains local, excluded from the npm file list and distribution size totals. `--watch --insight` is supported. Names already stripped by Cargo cannot be recovered; use `strip = false` in the release profile for analysis.

## Interpreting output

Input defaults to `pkg/`. A directory selects `.taraba/insight.wasm`, otherwise `app.wasm`. An explicit `taraba insight input.wasm` inspects that file directly. It does not build or modify files. Component containers are unsupported; pass their individual generated Core modules.

| Field / option | Interpretation |
|---|---|
| Sections | Includes ID/length headers; the sum plus the 8-byte preamble equals input size |
| Shallow | Function bytes including body-length LEB, locals and instructions |
| Retained | Function bytes dominated by this function in the reference graph |
| `--paths <substring>` | Filter names and show one shortest root-to-function path |
| `--retained` | Sort by retained bytes; default is shallow bytes |
| `--filter <substring>` | Literal name substring, not a regex |
| `--top N` | Result limit, default 20; also applies to JSON |
| Groups | Heuristic formatting/panic/allocator/other groups, summing shallow bytes |

Roots include exports, start and table/global function references; edges include direct calls and `ref.func`. Runtime indirect-call targets are not inferred, and table/global references are conservative roots. Other keeping paths may exist. Retained bytes exclude data, types and other sections; they are not removable artifact bytes, and retained rows cannot be added together.

JSON uses `schema: 1`. `total_bytes` counts the analysis input, `name_bytes` counts names, and `deployment_bytes` identifies paired deployed Wasm for directory input. It includes `function_count`, `named_functions`, `matched_functions`, `sections`, `functions`, `groups` and `notes`. `retained_bytes: null` means a function is not rooted in this reference graph.

The inspector decodes GC/externref and other modern features with wasmparser 0.252.0, then uses twiggy-ir 0.8.0 demangling/dominators. It avoids the old twiggy parser's externref-table limitation and needs neither a twiggy installation nor Node.js.

`just insight-check` runs the same 3,507 cases and scheduling checks against ordinary/analysis builds in JSPI/Future × std/no_std. It also checks formatting, warnings/suppression, actual npm tarball exclusion and stale-view rejection. It is part of `just check`; `just package-check` repeats it with an archived, installed CLI. Safari browser execution remains unverified.

[Development](development.md) · [Panic reporting](panic-reporting.md) · [Earlier twiggy/wasm-snip experiments](wasm-size-analysis.md)
