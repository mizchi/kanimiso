import { execFileSync } from "node:child_process";

// rust-toolchain.toml is directory-scoped. Keep the selected toolchain when
// installing an unpacked crate or building a consumer outside the repository.
export function rustEnvironment(root, env = process.env) {
  const active = execFileSync("rustup", ["show", "active-toolchain"], {
    cwd: root,
    env,
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)[0];
  return { ...env, RUSTUP_TOOLCHAIN: active };
}
