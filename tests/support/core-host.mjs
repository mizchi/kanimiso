// Promise normalization for generic fixture runners only. Product bindings
// generate typed application methods; runtimes have a single dispatch entry.
export function withTestApi(host) {
  return Object.assign(host, {
    promise: async (name, ...args) => host.call(name, ...args),
  });
}

// Test/experiment adapter for fixtures without a generated application API.
export function createLoader(createHost) {
  return async (source, { compileOptions, ...options } = {}) => {
    const module =
      source instanceof WebAssembly.Module
        ? source
        : await WebAssembly.compile(source, compileOptions);
    const names = WebAssembly.Module.exports(module)
      .filter(
        ({ name, kind }) =>
          kind === "function" &&
          !name.startsWith("rt_") &&
          !name.startsWith("cabi_"),
      )
      .map(({ name }) => name);
    const host = withTestApi(createHost(options, names));
    const loaded = await WebAssembly.instantiate(
      module,
      host.imports,
      compileOptions,
    );
    host.attach(
      (loaded instanceof WebAssembly.Instance ? loaded : loaded.instance)
        .exports,
    );
    return host;
  };
}
