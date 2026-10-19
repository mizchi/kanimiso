export function stringImports(values) {
  const decoder = /* @__PURE__ */ new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  const encoder = /* @__PURE__ */ new TextEncoder();
  return {
    "from-utf8": (ptr, len) =>
      values.put(
        decoder.decode(
          new Uint8Array(values.memory().buffer, ptr >>> 0, len >>> 0),
        ),
      ),
    "utf8-len": (id) => encoder.encode(values.get(id)).length,
    "utf16-len": (id) => values.get(id).length,
    "copy-utf8": (id, ptr, capacity) =>
      encoder.encodeInto(
        values.get(id),
        new Uint8Array(values.memory().buffer, ptr >>> 0, capacity >>> 0),
      ).written,
    normalize: (id, form) =>
      values.put(
        values.get(id).normalize(["NFC", "NFD", "NFKC", "NFKD"][form]),
      ),
    "to-uppercase": (id) => values.put(values.get(id).toUpperCase()),
    "to-lowercase": (id) => values.put(values.get(id).toLowerCase()),
    trim: (id) => values.put(values.get(id).trim()),
    equals: (a, b) => +(values.get(a) === values.get(b)),
    "code-points": (id) => values.put(values.get(id)[Symbol.iterator]()),
  };
}
