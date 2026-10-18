import assert from "node:assert/strict";
import test from "node:test";

test("counter stripping removes whole expressions without eating function/module endings", async () => {
  const { stripUsedCounter } = await import("../tools/import-contract.mjs");
  const wat =
    '(module (global $used (mut i32) (i32.const 0)) (func (export "used") (result i32) (global.get $used)) (func (global.set $used (i32.sub (global.get $used) (i32.const 1)))))';
  const stripped = stripUsedCounter(wat);
  assert.equal(
    stripped,
    '(module  (func (export "used") (result i32) (i32.const 0)) (func ))',
  );
  assert.doesNotMatch(stripped, /\$used/);
  assert.throws(() => stripUsedCounter("(module (global $used"));
});

test("private import renaming preserves every executable section and leaves unmapped names intact", async () => {
  const { renameImports } = await import("../tools/import-contract.mjs");
  // (import "jsrt" "add" (func (param i32 i32) (result i32)))
  // (func (export "start") (param i32 i32) (result i32) ...call import)
  const bytes = Buffer.from(
    "0061736d0100000001070160027f7f017f020c01046a7372740361646400000302010007090105737461727400010a0a0108002000200110000b",
    "hex",
  );
  const renamed = renameImports(bytes, { add: "a" });
  assert.deepEqual(
    WebAssembly.Module.imports(new WebAssembly.Module(renamed)),
    [{ module: "jsrt", name: "a", kind: "function" }],
  );
  const { exports } = new WebAssembly.Instance(
    new WebAssembly.Module(renamed),
    { jsrt: { a: (a, b) => a + b } },
  );
  assert.equal(exports.start(20, 22), 42);
  assert.deepEqual(renameImports(bytes, { absent: "x" }), bytes);
  assert.throws(() => renameImports(bytes, { add: "" }));
  assert.throws(() => renameImports(bytes.subarray(0, 15), { add: "a" }));
});
