import { createLoader } from "./core-host.mjs";
import { verifyWit } from "./wit-contract.mjs";
import { verifyScheduling } from "./scheduling.mjs";
const check = (ok, message) => {
  if (!ok) throw Error(message);
};
const tick = async (condition) => {
  for (let i = 0; i < 200 && !condition(); i++) await Promise.resolve();
  check(condition(), "JSPI task did not progress");
};
export async function verifyJspi(createHost, modules, cases) {
  const instantiate = createLoader(createHost);
  const entries = [];
  for (const { mode, bytes, probes } of modules) {
    const common = await verifyWit(async (add) => {
      const h = await instantiate(new Uint8Array(bytes), { bindings: { add } });
      return (...a) => h.promise("run", ...a);
    }, cases);
    const scheduling = await verifyScheduling(
      async (add) => {
        const h = await instantiate(new Uint8Array(bytes), {
          bindings: { add },
        });
        return (...a) => h.promise("run", ...a);
      },
      { serialized: true },
    );
    const pending = [];
    let active = 0,
      peak = 0;
    const host = await instantiate(new Uint8Array(probes), {
      bindings: {
        add: (a, b) => {
          peak = Math.max(peak, ++active);
          return new Promise((resolve) =>
            pending.push(() => {
              active--;
              resolve((a + b) | 0);
            }),
          );
        },
      },
    });
    const batch = Promise.all(
      Array.from({ length: 16 }, (_, i) => host.promise("hold", i, 10)),
    );
    for (let i = 0; i < 16; i++) {
      await tick(() => pending.length > 0);
      pending.pop()();
    }
    check(
      JSON.stringify(await batch) ===
        JSON.stringify(Array.from({ length: 16 }, (_, i) => i * 2 + 10)),
      "Rust stack spills changed across suspension",
    );
    check(peak === 1, "guest calls must serialize per instance");
    check(
      host.stats().queued === 0 && !host.stats().dead,
      "JSPI queue did not drain",
    );
    for (const reason of [undefined, { failure: mode }]) {
      let calls = 0;
      const failed = await instantiate(new Uint8Array(probes), {
        bindings: {
          add: () => {
            calls++;
            return Promise.reject(reason);
          },
        },
      });
      const outcomes = await Promise.all(
        [failed.promise("hold", 7, 9), failed.promise("run", 1, 2)].map((p) =>
          p.then(
            (value) => ({ fulfilled: true, value }),
            (error) => ({ fulfilled: false, error }),
          ),
        ),
      );
      check(
        outcomes.every((o) => !o.fulfilled && o.error === reason),
        "first rejection identity changed",
      );
      check(
        calls === 1 && failed.stats().dead && failed.stats().queued === 0,
        "failed Rust stack was entered again",
      );
    }
    entries.push({
      mode,
      common,
      scheduling,
      rust_stack_spill_tasks: 16,
      peak_active_imports: peak,
      all_passed: true,
    });
  }
  return { all_passed: true, entries };
}
