import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";
const built = await esbuild.build({
  entryPoints: ["src/host.mjs"],
  bundle: true,
  format: "esm",
  write: false,
  define: { __JSRT_DEBUG_ERRORS__: "false", __TARABA_ABORT__: "false" },
});
const { createHost } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
);

test("application imports are guarded and preserve first-fatal identity", async () => {
  const failure = new TypeError("application import failed");
  const host = createHost({
    bindings: {
      external() {
        throw failure;
      },
    },
  });
  assert.equal(typeof host.imports.app.external, "function");
  assert.throws(
    () => host.imports.app.external(),
    (e) => e === failure,
  );
  assert.equal(host.stats().dead, true);
  assert.throws(
    () => host.imports.jsrt.__root({}),
    (e) => e === failure,
  );
});
test("binding types come from the generated contract; application imports stay isolated", () => {
  const unchecked = createHost({ bindings: { bad: 1 } });
  assert.throws(() => unchecked.imports.app.bad(), TypeError);
  assert.equal(unchecked.stats().dead, true);
  const host = createHost({ bindings: { task_wake: () => 42 } });
  assert.equal(host.imports.app.task_wake(), 42);
  assert.notEqual(host.imports.app.task_wake, host.imports.jsrt.task_wake);
});
