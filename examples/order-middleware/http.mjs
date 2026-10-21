// HTTP/URL/JSON belong to the JS host; the guest receives a typed domain value.
export const MAX_BODY_BYTES = 65536;
function reply(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
const u32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
function decode(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.customer !== "string" ||
    !Array.isArray(value.items)
  )
    return;
  if (
    !value.items.every(
      (v) =>
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof v.sku === "string" &&
        u32(v.quantity) &&
        u32(v.unitPrice),
    )
  )
    return;
  return {
    customer: value.customer.toWellFormed(),
    items: value.items.map((v) => ({
      sku: v.sku,
      quantity: v.quantity,
      price: v.unitPrice,
    })),
  };
}
async function readBody(request) {
  if (!request.body) return { error: "invalid-json", status: 400 };
  const reader = request.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: "body-too-large", status: 413 };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ),
    };
  } catch {
    return { error: "invalid-json", status: 400 };
  }
}
export function createMiddleware(api) {
  return async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/orders") return reply(404, { error: "not-found" });
    if (request.method !== "POST")
      return reply(405, { error: "method-not-allowed" }, { allow: "POST" });
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      return reply(415, { error: "unsupported-media-type" });
    const dryRun = url.searchParams.get("dry-run");
    if (dryRun !== null && dryRun !== "0" && dryRun !== "1")
      return reply(400, { error: "invalid-query" });
    const body = await readBody(request);
    if (body.error) return reply(body.status, { error: body.error });
    const draft = decode(body.value);
    if (!draft) return reply(400, { error: "invalid-body" });
    const result = await api.process({
      ...draft,
      tenant: request.headers.get("x-tenant") ?? undefined,
      preview: dryRun === "1",
    });
    if (result.tag === "err")
      return reply(result.val === "denied" ? 403 : 422, { error: result.val });
    const receipt = result.val;
    return reply(200, {
      customer: receipt.customer,
      items: receipt.items.map((v) => ({
        sku: v.sku,
        quantity: v.quantity,
        unitPrice: v["price"],
      })),
      total: receipt.total,
      dryRun: receipt["preview"],
    });
  };
}
