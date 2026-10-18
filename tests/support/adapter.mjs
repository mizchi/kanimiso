import { createHost } from "../../dist/release.mjs";
import { createIO } from "./io.mjs";
export async function instantiate(
  bytes,
  options = {},
  hostFactory = createHost,
) {
  const io = createIO();
  const host = hostFactory({
    deferredAdd: (a, b) => io.defer(a, b),
    ...options,
  });
  const events = [];
  let onEvent = () => {};
  host.imports.jsrt.probe_event = (event) => {
    events.push(event);
    onEvent(event);
  };
  const { instance } = await WebAssembly.instantiate(bytes, host.imports);
  host.attach(instance.exports);
  return {
    host,
    events,
    onEvent(fn) {
      onEvent = fn;
    },
    api: {
      io,
      memory: instance.exports.memory,
      add: (...args) => host.call("add", ...args),
      start: (...args) => host.promise("start", ...args),
      awaitValue: (p) => host.promise("await_value", p),
      spawnEmpty: () => host.promise("spawn_empty"),
      diagnostics: () => host.stats(),
    },
  };
}
