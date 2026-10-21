// Build, reporting and verification share this explicit support matrix.
export const backends = [
  {
    id: "jspi",
    name: "taraba JSPI",
    modes: ["no_std", "std"],
    transport: "core",
  },
  {
    id: "future",
    name: "taraba Future (manual ABI)",
    modes: ["no_std", "std"],
    transport: "core",
  },
  {
    id: "future-typed",
    name: "taraba Future",
    modes: ["no_std", "std"],
    transport: "core",
    core_profile: "future",
  },
  {
    id: "embassy",
    name: "Embassy WASM + JsFuture",
    modes: ["std"],
    transport: "bindgen",
  },
  {
    id: "bindgen",
    name: "wasm-bindgen-futures",
    modes: ["no_std", "std"],
    transport: "bindgen",
  },
  {
    id: "tokio",
    name: "Tokio current-thread + LocalSet",
    modes: ["std"],
    transport: "bindgen",
  },
  {
    id: "async-executor",
    name: "async-executor LocalExecutor",
    modes: ["std"],
    transport: "bindgen",
  },
  {
    id: "async-std",
    name: "async-std spawn_local",
    modes: ["std"],
    transport: "bindgen",
  },
  {
    id: "futures-unordered",
    name: "FuturesUnordered task set",
    modes: ["no_std", "std"],
    transport: "bindgen",
  },
  {
    id: "wit-bindgen",
    name: "wit-bindgen async + jco",
    modes: ["no_std", "std"],
    transport: "core",
    component: true,
    cargo_features: ["component"],
  },
  {
    id: "component",
    name: "wit-bindgen async-spawn + jco",
    modes: ["no_std", "std"],
    transport: "core",
    component: true,
    cargo_features: ["component-spawn"],
  },
];
export const profiles = [
  ...backends.flatMap(({ id: backend, modes }) =>
    modes.map((mode) => ({ backend, mode, allocator: "taraba" })),
  ),
  ...["no_std", "std"].map((mode) => ({
    backend: "bindgen",
    mode,
    allocator: "wee",
  })),
  { backend: "embassy", mode: "std", allocator: "wee" },
];
