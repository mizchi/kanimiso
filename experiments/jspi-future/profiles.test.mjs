import assert from "node:assert/strict";
import test from "node:test";
import { bundleHost } from "./bundle.mjs";
import messages from "./error-codes.json" with { type: "json" };

const empty = new WebAssembly.Module(
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
);
// (import "app" "dropped" (func)) (func (export "run") (result i32)
//   call 0 i32.const 7). The real release bytes must forward this WIT callback.
const dropModule = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 8, 2, 96, 0, 0, 96, 0, 1, 127, 2, 15, 1, 3,
    97, 112, 112, 7, 100, 114, 111, 112, 112, 101, 100, 0, 0, 3, 2, 1, 1, 7, 7,
    1, 3, 114, 117, 110, 0, 1, 10, 8, 1, 6, 0, 16, 0, 65, 7, 11,
  ]),
);
const load = async (bytes) =>
  import(
    `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`
  );

test("release omits diagnostics and descriptions; debug preserves them with identical codes", async () => {
  const release = await bundleHost();
  const debug = await bundleHost({ debug: true });
  assert.ok(release.bytes.length < debug.bytes.length);
  assert.ok(!Buffer.from(release.bytes).toString().includes("already parked"));
  assert.ok(
    !Buffer.from(release.bytes).toString().includes("completion_queues"),
  );
  for (const message of Object.values(messages)) {
    assert.ok(
      !Buffer.from(release.bytes).toString().includes(message),
      message,
    );
    assert.ok(Buffer.from(debug.bytes).toString().includes(message), message);
  }
  for (const [bundle, diagnostics] of [
    [release, false],
    [debug, true],
  ]) {
    const { instantiate } = await load(bundle.bytes);
    await assert.rejects(instantiate(empty), (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.code, "JF4");
      assert.equal(
        error.message,
        diagnostics ? "JF4: add binding required" : "JF4",
      );
      return true;
    });
    await assert.rejects(
      instantiate(empty, { bindings: { add: () => 0, dropped: null } }),
      { code: "JF14" },
    );
    const host = await instantiate(empty, { bindings: { add: async () => 0 } });
    assert.deepEqual(
      Object.keys(host).sort(),
      diagnostics ? ["call", "promise", "stats"] : ["call", "promise"],
    );
    await assert.rejects(host.call("missing"), (error) => {
      assert.equal(error.code, "JF10");
      assert.equal(
        error.message,
        diagnostics ? "JF10: unknown export" : "JF10",
      );
      return true;
    });
    if (diagnostics) assert.equal(host.stats().dead, false);
  }
});

for (const debug of [false, true])
  test(`${debug ? "debug" : "release"}: Drop callback and first-fatal identity survive removal of diagnostics`, async () => {
    const { instantiate } = await load((await bundleHost({ debug })).bytes);
    let drops = 0;
    const host = await instantiate(dropModule, {
      bindings: { add: () => 0, dropped: () => drops++ },
    });
    for (let i = 0; i < 3; i++) assert.equal(await host.call("run"), 7);
    assert.equal(drops, 3);
    if (debug) assert.equal(host.stats().drops, 3);
    for (const reason of [undefined, { failed: true }]) {
      let calls = 0;
      const h = await instantiate(dropModule, {
        bindings: {
          add: () => 0,
          dropped: () => {
            calls++;
            throw reason;
          },
        },
      });
      const results = await Promise.all(
        [h.call("run"), h.call("run")].map((p) =>
          p.then(
            () => assert.fail("fatal call resolved"),
            (error) => ({ error }),
          ),
        ),
      );
      assert.equal(calls, 1);
      for (const result of results) assert.equal(result.error, reason);
      if (debug) assert.equal(h.stats().dead, true);
    }
  });
