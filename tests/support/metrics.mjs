import { gzipSync, brotliCompressSync, constants } from "node:zlib";

export function summarize(values) {
  if (!values.length || values.some((v) => !Number.isFinite(v) || v < 0))
    throw Error("invalid measurements");
  const sorted = values.toSorted((a, b) => a - b),
    n = sorted.length;
  return {
    min: sorted[0],
    median: n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1],
    max: sorted[n - 1],
    n,
  };
}

export function artifactSizes(bytes) {
  return {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}
