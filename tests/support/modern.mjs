// Portable tests shared by V8 and JavaScriptCore. No Node or browser APIs.
export async function verifyModern(fixtures, createHost, modules, cases) {
  const equal = (actual, expected, message) => {
    if (!Object.is(actual, expected)) throw Error(message);
  };
  const expectThrow = (fn, expected) => {
    try {
      fn();
    } catch (error) {
      equal(error, expected, "exception identity");
      return;
    }
    throw Error("expected an exception");
  };
  const results = {};
  for (const [name, test] of Object.entries({
    async js_string() {
      const { instance } = await WebAssembly.instantiate(
        new Uint8Array(fixtures["js-string"]),
        {},
        {
          builtins: ["js-string"],
          importedStringConstants: "s",
        },
      );
      equal(instance.exports.code(), "RT01", "imported string constant");
      for (const [a, b] of [
        ["RT01", ": detail"],
        ["日本語", "😀"],
        ["\ud800", "\udfff"],
        ["", ""],
      ])
        equal(
          instance.exports.concat(a, b),
          a + b,
          "builtin UTF-16 concatenation",
        );
      let typeChecked = false;
      try {
        instance.exports.concat(1, "x");
      } catch {
        typeChecked = true;
      }
      equal(typeChecked, true, "builtin rejects non-strings");
      return { passed: true, checks: 6 };
    },
    async exnref() {
      let thrown, wasm;
      const { instance } = await WebAssembly.instantiate(
        new Uint8Array(fixtures.exnref),
        {
          h: {
            run(mode) {
              if (mode === 1) throw thrown;
              if (mode === 2) return wasm.trap();
              return 42;
            },
          },
        },
      );
      wasm = instance.exports;
      equal(wasm.guard(0), 42, "normal return");
      const values = [
        new Error("external"),
        { value: 1 },
        Symbol("reason"),
        5n,
        undefined,
        null,
      ];
      for (const value of values) {
        thrown = value;
        expectThrow(() => wasm.guard(1), value);
      }
      equal(wasm.caught(), values.length, "catch_all_ref runs for JS throws");
      let trap;
      try {
        wasm.guard(2);
      } catch (error) {
        trap = error;
      }
      equal(
        trap instanceof WebAssembly.RuntimeError,
        true,
        "Wasm trap crosses JS frame",
      );
      equal(wasm.caught(), values.length, "trap bypasses Wasm catch_all_ref");
      // A manually thrown RuntimeError is catchable; its prototype is not the criterion.
      thrown = new WebAssembly.RuntimeError("manual");
      expectThrow(() => wasm.guard(1), thrown);
      equal(
        wasm.caught(),
        values.length + 1,
        "ordinary RuntimeError is catchable",
      );
      return { passed: true, checks: 12, trap_caught_by_wasm: false };
    },
    async funcref() {
      const { instance } = await WebAssembly.instantiate(
        new Uint8Array(fixtures.funcref),
      );
      const fn = instance.exports.ref();
      equal(fn(41), 42, "JS callable Wasm funcref");
      equal(instance.exports.apply(fn, 41), 42, "typed call_ref");
      let rejected = false;
      try {
        instance.exports.apply(() => 42, 41);
      } catch {
        rejected = true;
      }
      equal(rejected, true, "ordinary JS function is not a typed Wasm funcref");
      return { passed: true, checks: 3 };
    },
    async gc() {
      const { instance } = await WebAssembly.instantiate(
        new Uint8Array(fixtures.gc),
      );
      const object = {};
      equal(
        instance.exports.value(instance.exports.make(7, object)),
        object,
        "GC struct retains externref",
      );
      return { passed: true, checks: 1 };
    },
  })) {
    try {
      results[name] = await test();
    } catch (error) {
      results[name] = { passed: false, error: String(error) };
    }
  }
  results.runtime = [];
  for (const { mode, bytes } of modules) {
    const host = createHost(),
      { instance } = await WebAssembly.instantiate(
        new Uint8Array(bytes),
        host.imports,
      );
    host.attach(instance.exports);
    let tasks = 0;
    for (const batch of cases) {
      const values = await Promise.all(
        batch.map((c) => host.promise("start", ...c.args)),
      );
      for (let i = 0; i < values.length; i++)
        equal(values[i], batch[i].expected, "same two-await algorithm");
      tasks += values.length;
    }
    const stats = host.stats();
    equal(
      stats.live_tasks + stats.live_values + stats.live_waits,
      0,
      "runtime cleans task/wait/roots",
    );
    equal(stats.dead, false, "runtime remains live");
    let code;
    try {
      host.call("rt_poll", 0);
    } catch (error) {
      code = error.code;
    }
    equal(code, "RT11", "public boundary code");
    equal(host.stats().dead, false, "private API rejection does not poison");
    const pending = host.promise("start", 1, 2);
    let reason;
    pending.catch((error) => {
      reason = error;
    });
    let fatal;
    try {
      host.call("missing");
    } catch (error) {
      fatal = error;
    }
    await Promise.resolve();
    equal(fatal.code, "RT06", "missing export code");
    equal(reason, fatal, "first fatal rejects pending task by identity");
    equal(host.stats().dead, true, "first fatal closes runtime");
    expectThrow(() => host.call("start", 1, 2), fatal);
    const final = host.stats();
    equal(
      final.live_tasks + final.live_values + final.live_waits,
      0,
      "fatal clears all roots",
    );
    results.runtime.push({ mode, tasks, passed: true });
  }
  results.all_passed = Object.values(results)
    .filter((v) => v && !Array.isArray(v))
    .every((v) => v.passed === true);
  return results;
}
