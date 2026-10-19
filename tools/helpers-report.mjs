// Tables are generated from the same report used by the verified probes.
export function regexTable(report, lang) {
  const names =
    lang === "ja"
      ? ["構成", "Wasm B", "JS B", "合計 B"]
      : ["Variant", "Wasm B", "JS B", "Total B"];
  const labels = {
    "rust-regex-default": "regex 1.13.1 default / std",
    "rust-regex-minimal": "regex 1.13.1 std only / std",
    "helper-regexp-std": "taraba-helpers / std",
    "helper-regexp-no_std": "taraba-helpers / no_std",
  };
  return (
    `| ${names.join(" | ")} |\n|---|---:|---:|---:|\n` +
    Object.entries(labels)
      .map(([name, label]) => {
        const r = report.rows.find((r) => r.name === name);
        return `| ${label} | ${r.wasm_bytes} | ${r.js_bytes} | ${r.total_bytes} |`;
      })
      .join("\n")
  );
}
export function auditTable(report, lang) {
  const names =
    lang === "ja"
      ? ["プローブ", "Wasm B", "code B", "data B"]
      : ["Probe", "Wasm B", "code B", "data B"];
  return (
    `| ${names.join(" | ")} |\n|---|---:|---:|---:|\n` +
    report.rows
      .filter((r) => !r.name.includes("regex"))
      .map((r) => {
        const bytes = (name) =>
          r.sections.find((s) => s.name === name)?.bytes || 0;
        return `| ${r.name} | ${r.wasm_bytes} | ${bytes("code")} | ${bytes("data")} |`;
      })
      .join("\n")
  );
}

export function stringsTable(report, lang) {
  const names =
    lang === "ja"
      ? ["構成", "no_std Wasm B", "std Wasm B", "生成 JS B", "Rolldown JS B"]
      : [
          "Variant",
          "no_std Wasm B",
          "std Wasm B",
          "Generated JS B",
          "Rolldown JS B",
        ];
  return (
    `| ${names.join(" | ")} |\n|---|---:|---:|---:|---:|\n` +
    [
      "unused",
      "utf16-len",
      "uppercase",
      "normalize",
      "rust-normalize",
      "segment-count",
      "rust-grapheme-count",
      "roundtrip",
      "decoder",
      "full",
    ]
      .map((name) => {
        const bare = report.rows.find((r) => r.name === name && !r.std),
          std = report.rows.find((r) => r.name === name && r.std);
        if (
          bare.js_bytes !== std.js_bytes ||
          bare.bundled_js_bytes !== std.bundled_js_bytes
        )
          throw Error("std must not change the JS helper selection");
        return `| ${name} | ${bare.wasm_bytes} | ${std.wasm_bytes} | ${bare.js_bytes} | ${bare.bundled_js_bytes} |`;
      })
      .join("\n")
  );
}
