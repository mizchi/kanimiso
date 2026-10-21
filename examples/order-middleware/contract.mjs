import assert from "node:assert/strict";
import { createMiddleware } from "./http.mjs";
export const order = (count = 1) => ({
  customer: "  Alice 🦀  ",
  items: Array.from({ length: count }, (_, i) => ({
    sku: `item-${i}`,
    quantity: 2,
    unitPrice: 125,
  })),
});
export function request(
  body = order(),
  {
    tenant = "shop",
    url = "https://shop.test/orders",
    method = "POST",
    type = "application/json",
  } = {},
) {
  return new Request(url, {
    method,
    headers: {
      "content-type": type,
      ...(tenant === undefined ? {} : { "x-tenant": tenant }),
    },
    ...(method === "GET"
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
export async function verifyMiddleware(factory) {
  const authorizations = [];
  const api = await factory(async (tenant, total) => {
    await Promise.resolve();
    authorizations.push([tenant, total]);
    return tenant !== "blocked";
  });
  const handle = createMiddleware(api);
  const receipt = {
    customer: "Alice 🦀",
    items: [{ sku: "ITEM-0", quantity: 2, unitPrice: 125 }],
    total: 250,
    dryRun: false,
  };
  let cases = 0;
  const check = async (req, status, body) => {
    const response = await handle(req);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
    cases++;
  };
  await check(request(), 200, receipt);
  await check(request({ ...order(), customer: "\ud800" }), 200, {
    ...receipt,
    customer: "�",
  });
  await check(
    request(order(), { url: "https://shop.test/orders?dry-run=1" }),
    200,
    { ...receipt, dryRun: true },
  );
  await check(
    request({
      customer: " X ",
      items: [
        { sku: " a ", quantity: 2, unitPrice: 10 },
        { sku: "A", quantity: 3, unitPrice: 10 },
      ],
    }),
    200,
    {
      customer: "X",
      items: [{ sku: "A", quantity: 5, unitPrice: 10 }],
      total: 50,
      dryRun: false,
    },
  );
  const invalid = [
    [order(), { tenant: "" }, "invalid-tenant"],
    [order(), { tenant: "shop!" }, "invalid-tenant"],
    [{ ...order(), customer: " ".repeat(4) }, {}, "invalid-customer"],
    [{ ...order(), customer: "🦀".repeat(21) }, {}, "invalid-customer"],
    [{ ...order(), items: [] }, {}, "empty-order"],
    [order(129), {}, "too-many-items"],
    [
      { ...order(), items: [{ sku: "A\u2028", quantity: 1, unitPrice: 1 }] },
      {},
      "invalid-sku",
    ],
    [
      { ...order(), items: [{ sku: "🦀", quantity: 1, unitPrice: 1 }] },
      {},
      "invalid-sku",
    ],
    [
      { ...order(), items: [{ sku: "a", quantity: 0, unitPrice: 1 }] },
      {},
      "invalid-quantity",
    ],
    [
      { ...order(), items: [{ sku: "a", quantity: 101, unitPrice: 1 }] },
      {},
      "invalid-quantity",
    ],
    [
      { ...order(), items: [{ sku: "a", quantity: 1, unitPrice: 0 }] },
      {},
      "invalid-price",
    ],
    [
      { ...order(), items: [{ sku: "a", quantity: 1, unitPrice: 1000001 }] },
      {},
      "invalid-price",
    ],
    [
      {
        ...order(),
        items: [
          { sku: "a", quantity: 1, unitPrice: 1 },
          { sku: "A", quantity: 1, unitPrice: 2 },
        ],
      },
      {},
      "conflicting-price",
    ],
    [
      {
        ...order(),
        items: [
          { sku: "a", quantity: 100, unitPrice: 1 },
          { sku: "A", quantity: 1, unitPrice: 1 },
        ],
      },
      {},
      "invalid-quantity",
    ],
    [
      {
        ...order(),
        items: Array.from({ length: 50 }, (_, i) => ({
          sku: `A${i}`,
          quantity: 100,
          unitPrice: 1000000,
        })),
      },
      {},
      "amount-overflow",
    ],
  ];
  for (const [body, options, error] of invalid) {
    const before = authorizations.length;
    await check(request(body, options), 422, { error });
    assert.equal(
      authorizations.length,
      before,
      "invalid orders must never authorize",
    );
  }
  await check(
    new Request("https://shop.test/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(order()),
    }),
    422,
    { error: "missing-tenant" },
  );
  await check(request(order(), { tenant: "blocked" }), 403, {
    error: "denied",
  });
  await check(request("{}"), 400, { error: "invalid-body" });
  await check(request("{"), 400, { error: "invalid-json" });
  await check(
    request(order(), { url: "https://shop.test/orders?dry-run=maybe" }),
    400,
    { error: "invalid-query" },
  );
  for (const size of [1, 8, 64, 128]) {
    const req = order(size);
    const expected = {
      customer: "Alice 🦀",
      items: req.items.map((v) => ({ ...v, sku: v.sku.toUpperCase() })),
      total: 250 * size,
      dryRun: false,
    };
    for (let i = 0; i < 3; i++) await check(request(req), 200, expected);
    const responses = await Promise.all(
      Array.from({ length: 32 }, () => handle(request(req))),
    );
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
      cases++;
    }
  }
  const mixed = await Promise.all(
    Array.from({ length: 32 }, (_, i) =>
      handle(request(order(), { tenant: i % 2 ? "blocked" : "shop" })),
    ),
  );
  for (let i = 0; i < mixed.length; i++) {
    assert.equal(mixed[i].status, i % 2 ? 403 : 200);
    assert.deepEqual(
      await mixed[i].json(),
      i % 2 ? { error: "denied" } : receipt,
    );
    cases++;
  }
  assert.deepEqual(authorizations[0], ["shop", 250]);
  api.dispose?.();
  return { cases, authorization_calls: authorizations.length, concurrency: 32 };
}
