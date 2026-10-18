import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const run = (bin, args, options = {}) =>
  execFileSync(bin, args, { stdio: "inherit", ...options });
mkdirSync("dist/examples", { recursive: true });
for (const mode of ["no_std", "std"])
  for (const surface of ["minimal", "full", "probes"]) {
    const features = [
      ...(mode === "std" ? ["std"] : []),
      ...(surface === "full"
        ? ["test-api"]
        : surface === "probes"
          ? ["probes"]
          : []),
    ];
    run(
      "cargo",
      [
        "build",
        "--locked",
        "--release",
        "-p",
        "kanimiso-promise",
        "--target",
        "wasm32-unknown-unknown",
        "--no-default-features",
        ...(features.length ? ["--features", features.join(",")] : []),
      ],
      {
        env: {
          ...process.env,
          RUSTFLAGS:
            "-C link-arg=-zstack-size=65536 -C link-arg=--max-memory=1048576",
        },
      },
    );
    const raw = "target/wasm32-unknown-unknown/release/kanimiso_promise.wasm";
    const schema = JSON.parse(readFileSync("examples/promise/abi.json"));
    if (surface !== "minimal")
      Object.assign(schema.exports, {
        await_value: { params: ["own"], result: "own" },
        spawn_empty: { params: [], result: "own" },
      });
    if (surface === "probes")
      Object.assign(schema.exports, {
        self_wake: { params: ["i32"], result: "own" },
        oom_poll: { params: [], result: "own" },
      });
    const abi = `dist/examples/${mode}-${surface}.abi.json`;
    writeFileSync(abi, JSON.stringify(schema, null, 2) + "\n");
    run(process.execPath, [
      "tools/build-wasm.mjs",
      raw,
      "--abi",
      abi,
      "--output",
      `dist/examples/${mode}-${surface}.wasm`,
      ...(surface === "probes" ? ["--probes"] : []),
    ]);
  }
