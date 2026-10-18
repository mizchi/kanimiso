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
        "taraba-promise",
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
    const raw = "target/wasm32-unknown-unknown/release/taraba_promise.wasm";
    const extra =
      surface === "minimal"
        ? ""
        : "export await-value: func(p: value) -> value; export spawn-empty: func() -> value;";
    const probes =
      surface === "probes"
        ? "export self-wake: func(rounds: u32) -> value; export oom-poll: func() -> value;"
        : "";
    const wit = `dist/examples/${mode}-${surface}.wit`;
    writeFileSync(
      wit,
      `package taraba:fixtures; interface js {resource value;} world app {import js; use js.{value}; export start: func(a:s32,b:s32)->value; ${extra} ${probes}}`,
    );
    run(process.execPath, [
      "tools/build-wasm.mjs",
      raw,
      "--future",
      "--wit",
      wit,
      "--output",
      `dist/examples/${mode}-${surface}.wasm`,
      ...(surface === "probes" ? ["--probes"] : []),
    ]);
  }

for (const mode of ["no_std", "std"])
  for (const probes of [false, true]) {
    const features = [
      ...(mode === "std" ? ["std"] : []),
      ...(probes ? ["probes"] : []),
    ];
    run(
      "cargo",
      [
        "build",
        "--locked",
        "--release",
        "-p",
        "taraba-jspi-promise",
        "--target",
        "wasm32-unknown-unknown",
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
    run("target/release/taraba", [
      "build",
      "target/wasm32-unknown-unknown/release/taraba_jspi_promise.wasm",
      "--wit",
      "examples/jspi/wit",
      "--world",
      probes ? "probes" : "app",
      "--jspi",
      "--binaryen",
      ".cache/toolchains/binaryen-version_133/bin",
      "--out-dir",
      `.cache/jspi-example-${mode}-${probes}`,
    ]);
    const { copyFileSync } = await import("node:fs");
    copyFileSync(
      `.cache/jspi-example-${mode}-${probes}/app.wasm`,
      `dist/examples/jspi-${mode}-${probes ? "probes" : "minimal"}.wasm`,
    );
  }
