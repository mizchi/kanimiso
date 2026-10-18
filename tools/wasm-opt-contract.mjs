export function optimizationArgs(profile) {
  if (!["strip", "O3", "Os", "Oz"].includes(profile))
    throw Error(`unknown profile: ${profile}`);
  if (profile === "strip") return [];
  return [
    `-${profile}`,
    "--strip-debug",
    "--strip-producers",
    "--strip-target-features",
    ...[
      "mutable-globals",
      "sign-ext",
      "nontrapping-float-to-int",
      "simd",
      "bulk-memory",
      "reference-types",
      "multivalue",
      "gc",
      "tail-call",
      "exception-handling",
      "extended-const",
      "multimemory",
    ].map((f) => `--enable-${f}`),
  ];
}
