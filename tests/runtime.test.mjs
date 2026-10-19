import assert from "node:assert/strict";
import test from "node:test";

for (const profile of ["", "-jspi"])
  for (const debug of ["", "-debug"])
    test(`shared ${profile || "future"}${debug} runtime exposes only the host factory`, async () => {
      const runtime = await import(
        `../crates/taraba-cli/assets/taraba${profile}${debug}.mjs`
      );
      assert.deepEqual(Object.keys(runtime), ["createHost"]);
      const host = runtime.createHost();
      assert.deepEqual(
        Object.keys(host).sort(),
        (profile
          ? ["imports", "attach", "call", "stats"]
          : ["imports", "attach", "call", "stats", "cancel", "activeTasks"]
        ).sort(),
      );
    });

test("application I/O uses bindings without a demo-specific runtime import", async () => {
  const { createHost } = await import("../dist/canonical.mjs");
  const failure = { reason: "provider" };
  const host = createHost({
    bindings: {
      add(a, b) {
        if (a === 0) throw failure;
        return a + b;
      },
    },
  });
  assert.equal("deferred_add" in host.imports.jsrt, false);
  assert.equal(host.imports.app.add(20, 21), 41);
  assert.equal(host.imports.app.add(41, 1), 42);
  assert.equal(host.stats().requests, 2);
  assert.throws(
    () => host.imports.app.add(0, 1),
    (error) => error === failure,
  );
  assert.equal(host.stats().requests, 3);
  assert.equal(host.stats().dead, true);
});

for (const profile of ["", "-jspi"])
  test(`${profile || "future"} attachment does not inspect SharedArrayBuffer availability`, async () => {
    const { createHost } = await import(
      `../crates/taraba-cli/assets/taraba${profile}.mjs`
    );
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "SharedArrayBuffer",
    );
    const memory = new WebAssembly.Memory({ initial: 1 });
    try {
      Object.defineProperty(globalThis, "SharedArrayBuffer", {
        configurable: true,
        get() {
          throw Error("unexpected SharedArrayBuffer probe");
        },
      });
      const host = createHost();
      host.attach({ memory });
      assert.equal(host.stats().dead, false);
    } finally {
      Object.defineProperty(globalThis, "SharedArrayBuffer", descriptor);
    }
  });
