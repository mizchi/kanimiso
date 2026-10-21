// Independent JS baseline, kept behaviorally equivalent by the common corpus.
const trim = (s) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
const utf8 = new TextEncoder();
const err = (val) => ({ tag: "err", val });
export async function processOrder(value, authorize) {
  if (value.tenant === undefined) return err("missing-tenant");
  const tenant = trim(value.tenant);
  if (!tenant.length || tenant.length > 32 || /[^A-Za-z0-9_-]/.test(tenant))
    return err("invalid-tenant");
  const customer = trim(value.customer);
  if (!customer || utf8.encode(customer).length > 80)
    return err("invalid-customer");
  if (!value.items.length) return err("empty-order");
  if (value.items.length > 128) return err("too-many-items");
  const items = [];
  let total = 0;
  for (const item of value.items) {
    const sku = trim(item.sku);
    if (!sku.length || sku.length > 32 || /[^A-Za-z0-9_-]/.test(sku))
      return err("invalid-sku");
    if (item.quantity < 1 || item.quantity > 100)
      return err("invalid-quantity");
    if (item["price"] < 1 || item["price"] > 1000000)
      return err("invalid-price");
    const normalized = sku.toUpperCase();
    const existing = items.find((v) => v.sku === normalized);
    if (existing) {
      if (existing["price"] !== item["price"]) return err("conflicting-price");
      existing.quantity += item.quantity;
      if (existing.quantity > 100) return err("invalid-quantity");
    } else items.push({ ...item, sku: normalized });
    total += item.quantity * item["price"];
    if (total > 0xffffffff) return err("amount-overflow");
  }
  if (!(await authorize(tenant, total))) return err("denied");
  return {
    tag: "ok",
    val: { customer, items, total, preview: value["preview"] },
  };
}
