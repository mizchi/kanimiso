import assert from "node:assert/strict";
import test from "node:test";
import {
  createMiddleware,
  MAX_BODY_BYTES,
} from "../examples/order-middleware/http.mjs";
import { processOrder } from "../examples/order-middleware/reference.mjs";
import { verifyMiddleware } from "../examples/order-middleware/contract.mjs";

test("HTTP middleware and domain share a behavior contract", async () => {
  const report = await verifyMiddleware(async (authorize) => ({
    process: (value) => processOrder(value, authorize),
  }));
  assert.ok(report.cases >= 100);
});

test("HTTP routing and structural JSON validation happen before entering Wasm", async () => {
  let calls = 0;
  const handler = createMiddleware({
    process: async () => {
      calls++;
      throw Error("must not enter guest");
    },
  });
  for (const [request, status] of [
    [new Request("https://shop.test/unknown"), 404],
    [new Request("https://shop.test/orders"), 405],
    [
      new Request("https://shop.test/orders", { method: "POST", body: "{}" }),
      415,
    ],
    [
      new Request("https://shop.test/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      400,
    ],
    [
      new Request("https://shop.test/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customer: "a",
          items: [{ sku: "A", quantity: -1, unitPrice: 1 }],
        }),
      }),
      400,
    ],
  ])
    assert.equal((await handler(request)).status, status);
  assert.equal(calls, 0);
});

test("oversized streams are canceled before JSON parsing or a guest call", async () => {
  let canceled = false,
    pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(MAX_BODY_BYTES));
    },
    cancel() {
      canceled = true;
    },
  });
  const handler = createMiddleware({
    process: async () => {
      throw Error("unexpected guest");
    },
  });
  const response = await handler(
    new Request("https://shop.test/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    }),
  );
  assert.equal(response.status, 413);
  assert.ok(canceled);
  assert.ok(pulls <= 3, "must stop consuming the unbounded source");
});

test("foreign host errors preserve identity and a later request can succeed", async () => {
  const failure = { offline: true };
  let reject = true;
  const handler = createMiddleware({
    process: (v) =>
      processOrder(v, async () => {
        if (reject) throw failure;
        return true;
      }),
  });
  const request = () =>
    new Request("https://shop.test/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": "shop" },
      body: JSON.stringify({
        customer: "A",
        items: [{ sku: "a", quantity: 1, unitPrice: 1 }],
      }),
    });
  await assert.rejects(handler(request()), (e) => e === failure);
  reject = false;
  assert.equal((await handler(request())).status, 200);
});

test("the shared verifier rejects a broken domain implementation", async () => {
  await assert.rejects(
    verifyMiddleware(async () => ({
      process: async () => ({
        tag: "ok",
        val: { customer: "wrong", items: [], total: 0, "dry-run": false },
      }),
    })),
    assert.AssertionError,
  );
});

test("UTF-8 body byte limit includes multibyte characters and accepts the exact boundary", async () => {
  const handle = createMiddleware({
    process: (value) => processOrder(value, async () => true),
  });
  const json = JSON.stringify({
    customer: "🦀",
    items: [{ sku: "a", quantity: 1, unitPrice: 1 }],
  });
  const body =
    json + " ".repeat(MAX_BODY_BYTES - new TextEncoder().encode(json).length);
  const req = (text) =>
    new Request("https://shop.test/orders", {
      method: "POST",
      headers: {
        "content-type": "Application/JSON; charset=utf-8",
        "x-tenant": "shop",
      },
      body: text,
    });
  assert.equal((await handle(req(body))).status, 200);
  assert.equal((await handle(req(body + " "))).status, 413);
  const bad = new Request("https://shop.test/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tenant": "shop" },
    body: new Uint8Array([0xc0, 0xaf]),
  });
  assert.equal((await handle(bad)).status, 400);
});
