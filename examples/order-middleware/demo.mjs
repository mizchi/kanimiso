import { readFile } from "node:fs/promises";
import { createHost } from "./pkg/index.js";
import { createMiddleware } from "./pkg/http.mjs";
const host = createHost({
  bindings: {
    authorize: async (tenant, total) => tenant === "shop" && total <= 1000000,
  },
});
const { instance } = await WebAssembly.instantiate(
  await readFile(new URL("./pkg/app.wasm", import.meta.url)),
  host.imports,
);
host.attach(instance.exports);
const handle = createMiddleware(host);
try {
  const response = await handle(
    new Request("https://shop.test/orders?dry-run=1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": "shop" },
      body: JSON.stringify({
        customer: "  Alice 🦀  ",
        items: [{ sku: " item-1 ", quantity: 2, unitPrice: 125 }],
      }),
    }),
  );
  console.log(response.status, await response.json());
} finally {
  host.dispose();
}
