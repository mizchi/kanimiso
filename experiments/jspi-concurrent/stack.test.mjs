import assert from "node:assert/strict";
import test from "node:test";
import { createStacks } from "./stack.mjs";

const fixture = () => {
  const exports = {
    rt_jspi_stack: new WebAssembly.Global({ value: "i32" }, 1),
    memory: new WebAssembly.Memory({ initial: 2, maximum: 8 }),
    __stack_pointer: new WebAssembly.Global(
      { value: "i32", mutable: true },
      65536,
    ),
    __stack_low: new WebAssembly.Global({ value: "i32" }, 0),
    __stack_high: new WebAssembly.Global({ value: "i32" }, 65536),
  };
  const stacks = createStacks(() => {});
  stacks.attach(exports);
  return { exports, stacks, hooks: stacks.imports };
};
test("overlapping snapshots restore independently, using the current memory buffer", () => {
  const { exports, stacks, hooks } = fixture();
  const a = hooks.enter();
  new Uint8Array(exports.memory.buffer).fill(11, 65024, 65536);
  hooks.suspend(a, 65024);
  const b = hooks.enter();
  new Uint8Array(exports.memory.buffer).fill(22, 64512, 65536);
  hooks.suspend(b, 64512);
  exports.memory.grow(1);
  assert.equal(hooks.resume(a), 65024);
  assert.ok(
    new Uint8Array(exports.memory.buffer)
      .subarray(65024, 65536)
      .every((v) => v === 11),
  );
  hooks.leave(a);
  assert.equal(hooks.resume(b), 64512);
  assert.ok(
    new Uint8Array(exports.memory.buffer)
      .subarray(64512, 65536)
      .every((v) => v === 22),
  );
  hooks.leave(b);
  assert.equal(stacks.stats().snapshot_bytes, 0);
  assert.equal(stacks.stats().roots, 0);
});
test("invalid ranges and phase transitions never restore foreign bytes", () => {
  for (const bottom of [-16, 1, 65552, NaN, 2 ** 32]) {
    const { exports, hooks } = fixture();
    const a = hooks.enter();
    const before = new Uint8Array(exports.memory.buffer).slice();
    assert.throws(() => hooks.suspend(a, bottom));
    assert.deepEqual(new Uint8Array(exports.memory.buffer), before);
  }
  const { hooks } = fixture();
  const a = hooks.enter();
  assert.throws(() => hooks.resume(a));
  hooks.suspend(a, 65520);
  assert.throws(() => hooks.suspend(a, 65520));
  hooks.resume(a);
  hooks.leave(a);
  assert.throws(() => hooks.resume(a));
  assert.throws(() => hooks.leave(a));
});
test("closing clears parked snapshots and rejects later access", () => {
  let closed = false;
  const stacks = createStacks(() => {
    if (closed) throw Error("closed");
  });
  const { exports } = fixture();
  stacks.attach(exports);
  const a = stacks.imports.enter();
  stacks.imports.suspend(a, 65024);
  closed = true;
  stacks.close();
  assert.equal(stacks.stats().snapshot_bytes, 0);
  assert.equal(stacks.stats().roots, 0);
  assert.throws(() => stacks.imports.resume(a), /closed/);
});

test("unprotected modules and malformed stack bounds are rejected", () => {
  for (const change of [
    (e) => delete e.rt_jspi_stack,
    (e) => (e.__stack_high = new WebAssembly.Global({ value: "i32" }, 65535)),
    (e) =>
      (e.__stack_pointer = new WebAssembly.Global({ value: "i32" }, 65536)),
  ]) {
    const { exports } = fixture();
    change(exports);
    assert.throws(() => createStacks(() => {}).attach(exports), {
      code: "JC1",
    });
  }
});

test("a missing suspension handoff fails before overwriting another activation", () => {
  const { exports, hooks } = fixture();
  const root = hooks.enter();
  hooks.suspend(root, 65024);
  new Uint8Array(exports.memory.buffer).fill(99, 65024, 65536);
  exports.__stack_pointer.value = 65024;
  assert.throws(() => hooks.resume(root), { code: "JC1" });
  assert.ok(
    new Uint8Array(exports.memory.buffer)
      .subarray(65024, 65536)
      .every((v) => v === 99),
  );
});
