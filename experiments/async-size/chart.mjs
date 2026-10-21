import { readmeEntries } from "./report.mjs";

const labels = {
  jspi: "taraba JSPI",
  "future-typed": "taraba Future",
  bindgen: "wasm-bindgen-futures",
  embassy: "Embassy + JsFuture",
  "wit-bindgen": "wit-bindgen + jco",
};
const escape = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
const kb = (bytes) => (bytes / 1000).toFixed(3);
const px = (value) => value.toFixed(3);

export function sizeChart(report) {
  const entries = readmeEntries(report);
  const tick =
    Math.ceil(Math.max(...entries.map((e) => e.runtime.raw)) / 4 / 5000) * 5000;
  const max = tick * 4;
  const scale = 330 / max;
  let nextTop = 170;
  const groups = ["std", "no_std"].map((mode) => {
    const rows = entries.filter((e) => e.mode === mode);
    const group = { mode, rows, top: nextTop };
    nextTop += 33 + rows.length * 44 + 3;
    return group;
  });
  const axisY = nextTop - 15;
  const height = nextTop + 54;
  const text = (x, y, value, attrs = "") =>
    `<text x="${x}" y="${y}" ${attrs}>${escape(value)}</text>`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}" role="img" aria-labelledby="title desc">`,
    '<title id="title">Async application size: taraba, wasm-bindgen-futures, Embassy and wit-bindgen</title>',
    '<desc id="desc">Uncompressed Wasm and minified JavaScript in kB. Stacked bars share one zero-based scale across std and no_std. Every configuration passes the same 3,507 cases with two Promise waits. Whole application sizes, using taraba-allocator with size classes disabled. Execution contracts differ.</desc>',
    '<style>text{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#23313c}.muted{fill:#586672;font-size:12px}.number{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:16px;text-anchor:end;font-variant-numeric:tabular-nums}.wasm{fill:#df6638}.js{fill:#427e9d}</style>',
    `<rect x="0.5" y="0.5" width="959" height="${height - 1}" rx="12" fill="#ffffff" stroke="#dce2e6"/>`,
    text(32, 42, "Async application size", 'font-size="25" font-weight="700"'),
    text(
      32,
      66,
      "Two Promise waits · wasm-opt -Oz · minified JS · uncompressed",
      'font-size="13" class="muted"',
    ),
    '<rect class="wasm" x="32" y="84" width="12" height="12" rx="2"/>',
    text(50, 94, "Wasm", 'class="muted"'),
    '<rect class="js" x="111" y="84" width="12" height="12" rx="2"/>',
    text(129, 94, "JavaScript", 'class="muted"'),
    text(
      928,
      94,
      `${report.created_at.slice(0, 10)} · 1 kB = 1,000 bytes`,
      'class="muted" text-anchor="end"',
    ),
    text(32, 132, "Configuration", 'class="muted" font-weight="600"'),
    text(270, 132, "Wasm + JavaScript", 'class="muted" font-weight="600"'),
    text(
      700,
      132,
      "Wasm kB",
      'class="muted" text-anchor="end" font-weight="600"',
    ),
    text(
      800,
      132,
      "JS kB",
      'class="muted" text-anchor="end" font-weight="600"',
    ),
    text(
      928,
      132,
      "Total kB",
      'class="muted" text-anchor="end" font-weight="600"',
    ),
    '<path d="M32 146H928" stroke="#dce2e6"/>',
  ];
  for (const { mode, top, rows } of groups) {
    svg.push(text(32, top, mode, 'font-size="13" font-weight="700"'));
    for (const [index, entry] of rows.entries()) {
      const y = top + 33 + index * 44;
      const wasmWidth = entry.wasm_bytes * scale;
      const jsWidth = entry.js_bytes * scale;
      svg.push(
        `<g id="${entry.backend}-${mode}">`,
        `<title>${escape(labels[entry.backend])} / ${mode}: Wasm ${kb(entry.wasm_bytes)} kB + JS ${kb(entry.js_bytes)} kB = ${kb(entry.runtime.raw)} kB</title>`,
        ...(entry.backend === "jspi" || entry.backend === "future-typed"
          ? [
              `<rect x="20" y="${y - 21}" width="920" height="38" rx="6" fill="#fff5ef"/>`,
            ]
          : []),
        text(
          32,
          y + 5,
          labels[entry.backend],
          `font-size="15" font-weight="${entry.backend === "jspi" || entry.backend === "future-typed" ? 600 : 400}"`,
        ),
        `<rect class="wasm" x="270" y="${y - 10}" width="${px(wasmWidth)}" height="20"/>`,
        `<rect class="js" x="${px(270 + wasmWidth)}" y="${y - 10}" width="${px(jsWidth)}" height="20"/>`,
        text(700, y + 5, kb(entry.wasm_bytes), 'class="number"'),
        text(800, y + 5, kb(entry.js_bytes), 'class="number"'),
        text(
          928,
          y + 5,
          kb(entry.runtime.raw),
          'class="number" font-weight="700"',
        ),
        "</g>",
      );
    }
  }
  svg.push(`<path d="M270 ${axisY}H600" stroke="#bac4cb"/>`);
  for (let bytes = 0; bytes <= max; bytes += tick) {
    const x = px(270 + bytes * scale);
    svg.push(
      `<path d="M${x} ${axisY}v5" stroke="#bac4cb"/>`,
      text(x, axisY + 20, bytes / 1000, 'class="muted" text-anchor="middle"'),
    );
  }
  svg.push(
    text(270, axisY + 40, "Same scale for both groups · kB", 'class="muted"'),
    text(
      32,
      height - 13,
      "Whole applications · 3,507 shared cases · Component includes jco · Embassy uses std",
      'class="muted"',
    ),
    "</svg>",
    "",
  );
  return svg.join("\n");
}
