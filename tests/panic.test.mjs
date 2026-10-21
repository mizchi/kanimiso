import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";

for (const profile of ["host", "jspi"])
  for (const debug of [false, true])
    test(`${profile}: panic reports are fatal; details are debug-only (${debug})`, async () => {
      const bundle = await esbuild.build({
        entryPoints: [`src/${profile}.mjs`],
        bundle: true,
        minify: true,
        format: "esm",
        write: false,
        define: {
          __JSRT_DEBUG_ERRORS__: String(debug),
          __TARABA_ABORT__: "false",
        },
      });
      const { createHost } = await import(
        `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
      );
      const host = createHost();
      const memory = new WebAssembly.Memory({ initial: 1 });
      const detail = "panic sentinel 日本語";
      const bytes = new TextEncoder().encode(detail);
      new Uint8Array(memory.buffer, 32, bytes.length).set(bytes);
      host.attach({ memory });
      let fatal;
      await assert.rejects(
        Promise.resolve().then(() =>
          host.imports["taraba:panic"].report(32, bytes.length),
        ),
        (e) => {
          fatal = e;
          assert.equal(e.code, "PN01");
          assert.ok(e.message.includes("docs/error-codes.md#pn01"));
          assert.equal(e.message.includes(detail), debug);
          assert.ok(e.stack);
          return true;
        },
      );
      await assert.rejects(
        Promise.resolve().then(() => host.call("trap")),
        (e) => e === fatal,
      );
      assert.equal(host.stats().dead, true);
      if (!debug)
        assert.ok(!bundle.outputFiles[0].text.includes("TextDecoder"));
    });

test("panic before attach still closes the host without trying to read guest memory", async () => {
  const { createHost } = await import("../dist/jspi-debug.mjs");
  const host = createHost();
  assert.throws(
    () => host.imports["taraba:panic"].report(32, 99),
    (e) => e.code === "PN01",
  );
  assert.equal(host.stats().dead, true);
});

test("a panic during polling rejects every pending task without running Drop", async () => {
  const { createHost } = await import("../dist/canonical.mjs");
  const host = createHost();
  let drops = 0;
  host.attach({
    rt_poll() {
      host.imports["taraba:panic"].report(0, 0);
    },
    rt_drop() {
      drops++;
    },
  });
  const tasks = [];
  for (let i = 0; i < 2; i++) {
    const id = host.imports.jsrt.task_new();
    tasks.push(host.imports.jsrt.task_promise(id));
    host.imports.jsrt.task_start(id, 32);
  }
  const results = await Promise.allSettled(tasks);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[0].reason.code, "PN01");
  assert.equal(results[0].reason, results[1].reason);
  assert.equal(drops, 0);
  const stats = host.stats();
  assert.equal(stats.live_tasks + stats.live_waits + stats.live_values, 0);
});
