import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
for (const debug of [false, true]) {
  const result = await esbuild.build({
    entryPoints: [fileURLToPath(new URL("./gates.mjs", import.meta.url))],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    define: { __JF_DEBUG__: String(debug) },
  });
  const { Gates } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
  );
  const variant = debug ? "debug" : "release";

  test(`${variant}: wake before park is latched and duplicate wake is coalesced`, async () => {
    const g = new Gates(),
      id = g.open_();
    g.signal_(id);
    g.signal_(id);
    await g.park_(id);
    let done = false;
    const next = g.park_(id).then(() => (done = true));
    await Promise.resolve();
    assert.equal(done, false);
    g.signal_(id);
    await next;
    g.close_(id);
    if (debug) assert.equal(g.stats_().gates, 0);
  });
  test(`${variant}: wake after park resumes exactly one wait; stale ids never wake new gates`, async () => {
    const g = new Gates(),
      id = g.open_();
    let count = 0;
    const p = g.park_(id).then(() => count++);
    g.signal_(id);
    g.signal_(id);
    await p;
    assert.equal(count, 1);
    g.close_(id);
    const other = g.open_();
    assert.notEqual(other, id);
    g.signal_(id);
    let done = false;
    const q = g.park_(other).then(() => (done = true));
    await Promise.resolve();
    assert.equal(done, false);
    g.signal_(other);
    await q;
    g.close_(other);
  });
  test(`${variant}: retiring host rejects parked calls with exact first fatal reason`, async () => {
    const g = new Gates(),
      id = g.open_(),
      reason = undefined;
    const p = g.park_(id);
    g.retire_(reason);
    await assert.rejects(p, (e) => e === reason);
    if (debug) assert.equal(g.stats_().gates, 0);
    if (debug) assert.equal(g.stats_().dead, true);
    assert.throws(
      () => g.open_(),
      (e) => e === reason,
    );
  });
  test(`${variant}: park twice is rejected, close retires a wait, monotonic IDs never wrap`, async () => {
    const g = new Gates(),
      id = g.open_(),
      p = g.park_(id);
    assert.throws(() => g.park_(id), { code: "JF12" });
    g.close_(id);
    await assert.rejects(p, { code: "JF13" });
    g.signal_(id);
    assert.throws(() => g.park_(id), { code: "JF5" });
    const limited = new Gates(2);
    limited.close_(limited.open_());
    limited.close_(limited.open_());
    assert.throws(() => limited.open_(), { code: "JF11" });
  });
}
