import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";
import { bundleHost, privateProperties } from "./bundle.mjs";

test("only explicitly private properties are mangled; public and builtin names survive", async () => {
  const result = await esbuild.transform(
    `export default {bindings:{add:1},call:2,promise:3,stats:4,
      gates:5,parks:6,dead:7,jobs:8,completion_queues:9,queued:10,polls:11,drops:12,
      app:{fail:1,open:2,signal:3,close:4,drain:5,park:6,begin:7,ready:8,take:9,cancel:10,dropped:11},
      instance:{exports:{memory:{buffer:1}}},resolve:1,reject:2,then:3,catch:4,finally:5,
      value_:6,ready_:7};`,
    { minify: true, mangleProps: privateProperties, format: "esm" },
  );
  const { default: value } = await import(
    `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`
  );
  assert.equal(value.bindings.add, 1);
  assert.equal(value.instance.exports.memory.buffer, 1);
  assert.deepEqual(Object.keys(value.app), [
    "fail",
    "open",
    "signal",
    "close",
    "drain",
    "park",
    "begin",
    "ready",
    "take",
    "cancel",
    "dropped",
  ]);
  for (const key of [
    "call",
    "promise",
    "stats",
    "gates",
    "parks",
    "dead",
    "jobs",
    "completion_queues",
    "queued",
    "polls",
    "drops",
    "resolve",
    "reject",
    "then",
    "catch",
    "finally",
  ])
    assert.ok(Object.hasOwn(value, key), key);
  assert.ok(!Object.hasOwn(value, "value_"));
  assert.ok(!Object.hasOwn(value, "ready_"));
});

test("host bundle shrinks using private properties without changing its module API", async () => {
  const plain = await bundleHost({ mangle: false });
  const compact = await bundleHost();
  assert.ok(compact.bytes.length < plain.bytes.length);
  assert.ok(Object.keys(compact.mangleCache).length >= 10);
  for (const key of Object.keys(compact.mangleCache))
    assert.match(key, privateProperties);
  for (const { bytes } of [plain, compact]) {
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`
    );
    assert.deepEqual(Object.keys(mod), ["instantiate"]);
    await assert.rejects(mod.instantiate(null), {
      code: "JF4",
      message: "JF4",
    });
  }
});
