import { createHost } from "./host.mjs";
export { createHost };
export async function instantiate(source, { compileOptions, ...options } = {}) {
  const host = createHost(options);
  const loaded = await WebAssembly.instantiate(
    source,
    host.imports,
    compileOptions,
  );
  const instance =
    loaded instanceof WebAssembly.Instance ? loaded : loaded.instance;
  host.attach(instance.exports);
  return host;
}
