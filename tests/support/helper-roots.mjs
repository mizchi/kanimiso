import assert from "node:assert/strict";

// Observe the private ownership contract at actual Wasm imports. Test-only:
// product hosts expose no root/get/release or helper-debug API.
export function observeHelperRoots(host) {
  const values = new Set(),
    regex = new Set();
  const owned = {
    strings: [
      "from-utf8",
      "normalize",
      "to-uppercase",
      "to-lowercase",
      "trim",
      "code-points",
    ],
    values: ["clone"],
    iterator: ["next"],
    segmenter: ["new", "segment", "text"],
    encoding: ["new", "decode"],
    regexp: ["compile", "compile-string"],
  };
  for (const [module, names] of Object.entries(owned)) {
    const api = host.imports[`taraba:helpers/${module}@0.1.0`];
    if (!api) continue;
    const roots = module === "regexp" ? regex : values;
    for (const name of names) {
      const original = api[name];
      if (!original) continue;
      api[name] = (...args) => {
        let id;
        try {
          id = original(...args) >>> 0;
        } catch (error) {
          if (module === "iterator" && name === "next")
            roots.delete(args[0] >>> 0);
          throw error;
        }
        if (id) {
          assert.ok(!roots.has(id), `${module}.${name}: root ID reused`);
          roots.add(id);
        }
        return id;
      };
    }
    const release =
      module === "values" || module === "regexp"
        ? ["drop"]
        : module === "iterator"
          ? ["close"]
          : [];
    for (const name of release) {
      const original = api[name];
      api[name] = (id) => {
        assert.ok(roots.delete(id >>> 0), `${module}.${name}: double release`);
        return original(id);
      };
    }
  }
  return {
    values: () => values.size,
    regex: () => regex.size,
    total: () => values.size + regex.size,
  };
}
