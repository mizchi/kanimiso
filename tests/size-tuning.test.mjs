import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
for (const [name, budget] of [
  ["release", 3610],
  ["abort", 4500],
  ["jspi", 1130],
]) {
  test(`${name}: shared runtime stays within the tuned size budget`, () => {
    assert.ok(
      readFileSync(`dist/${name}.mjs`).length <= budget,
      `${name} exceeds ${budget} B`,
    );
  });
}

for (const variant of ["release", "abort"]) {
  test(`${variant}: private property mangling preserves public callback names`, async () => {
    const { createHost } = await import(`../dist/${variant}.mjs`);
    const names = ["close", "controller", "context", "scope", "tasks"];
    const h = createHost({
      bindings: Object.fromEntries(names.map((n) => [n, (v) => v + 1])),
    });
    for (const name of names) assert.equal(h.imports.app[name](41), 42);
    assert.equal(h.stats().requests, names.length);
    h.dispose();
  });
}
