// Inspect sizes only. Data segments are runtime memory, not custom metadata.
// This does not decode instructions or replace wasm-tools validation.
export function wasmSections(input) {
  const bytes = Buffer.from(input);
  if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
    throw Error("expected a core Wasm module");
  const names = [
    "custom",
    "type",
    "import",
    "function",
    "table",
    "memory",
    "global",
    "export",
    "start",
    "element",
    "code",
    "data",
    "data-count",
    "tag",
  ];
  let pos = 8;
  const uint = (end) => {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      if (pos >= end) throw Error("truncated u32");
      const b = bytes[pos++];
      n += (b & 127) * 2 ** (i * 7);
      if (n > 0xffffffff) throw Error("u32 overflow");
      if (!(b & 128)) return n;
    }
    throw Error("invalid u32");
  };
  const rows = [];
  while (pos < bytes.length) {
    const start = pos,
      id = bytes[pos++],
      payload_bytes = uint(bytes.length);
    const payload_start = pos,
      end = pos + payload_bytes;
    if (end > bytes.length) throw Error("truncated section");
    let name = names[id] ?? `section-${id}`;
    if (id === 0) {
      const length = uint(end);
      if (pos + length > end) throw Error("truncated custom section name");
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(pos, pos + length),
      );
    }
    rows.push({
      id,
      name,
      bytes: end - start,
      payload_bytes,
      start,
      payload_start,
      end,
    });
    pos = end;
  }
  return rows;
}
