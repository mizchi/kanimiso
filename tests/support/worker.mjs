import { createIO } from "./io.mjs";
import { verifyPromises } from "./promises.mjs";

export function workerService(modules, createHost) {
  return {
    async fetch(request) {
      const mode = new URL(request.url).pathname.slice(1);
      if (mode === "health") return new Response("ok");
      if (!modules[mode]) return new Response("not found", { status: 404 });
      try {
        const io = createIO();
        const host = createHost({
          bindings: { add: (a, b) => io.defer(a, b) },
        });
        const e = new WebAssembly.Instance(modules[mode], host.imports).exports;
        host.attach(e);
        const checked = await verifyPromises({
          io,
          memory: e.memory,
          add: e.add,
          start: e.start,
          awaitValue: e["await-value"],
          spawnEmpty: e["spawn-empty"],
          diagnostics: () => host.stats(),
        });
        return Response.json({
          mode,
          all_passed: checked.all_passed,
          checks: checked.common.checks,
          extra_checks: checked.extra_checks,
          tasks: checked.common.tasks,
          diagnostics: host.stats(),
          memory_bytes: e.memory.buffer.byteLength,
        });
      } catch (error) {
        return Response.json(
          { error: String(error), stack: error.stack },
          { status: 500 },
        );
      }
    },
  };
}
