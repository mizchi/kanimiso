# Release procedure

English | [日本語](releasing.ja.md)

Publishing requires an explicit release request. These commands are a procedure,
not an automated publishing task. Keep version numbers consistent across the
four crates, scaffold templates, embedded notices and documentation.

Keep the private Rust/JS ABI stable within a CLI compatibility line. An
incompatible change requires a new minor for 0.x, a new patch for 0.0.x, or a new
major from 1.0 onward. Cargo builds check runtime/helper crate versions; raw
Wasm updates across lines require an explicit source rebuild. Keep the private
WIT import versions aligned with the ABI they describe.

Before publishing, run `just check`, `just msrv-check` and `just package-check`.
For unsafe/ownership changes also run `just miri`, `just kani` and `just stress 60`.
Commit the release candidate, push it and confirm CI succeeds for that exact SHA.
Run `just package-check --require-clean` again on the clean commit: the archives' `.cargo_vcs_info.json`
must name that commit without `dirty: true`. Miri/Kani cover selected native models;
native Component-host execution remains unverified. Safari validation is completed through WebKit E2E (`just browser-check` / `just webkit-latest-check`); an additional Safari.app run is not required.

Publish the guest libraries before the CLI, so newly scaffolded projects can
resolve every dependency. Each guest requires the Wasm target during Cargo's
package verification; the CLI is a native executable. First run these with
`--dry-run`, then, after explicit authorization, without it:

```sh
cargo publish --locked -p taraba --target wasm32-unknown-unknown
cargo publish --locked -p taraba-allocator --target wasm32-unknown-unknown
cargo publish --locked -p taraba-helpers --all-features --target wasm32-unknown-unknown
cargo publish --locked -p taraba-cli
```

After the libraries are available on crates.io, install the CLI from the
registry in a fresh directory outside the checkout:

```sh
cargo install taraba-cli --version 0.2.1 --locked --root ./cli
./cli/bin/taraba new hello --no-std
cd hello
../cli/bin/taraba build
pnpm --dir pkg pack
```

Repeat with std and `new --future`, and add `taraba-helpers = { version = "0.2.1", features = ["strings"] }`.
Install the resulting npm tarball into another application, typecheck its
`AppBindings`/`AppHost`, instantiate Wasm and run a generated method. Exercise
the Component path separately with wasm-tools/jco. Binaryen 133 must be available;
see the [installation guide](guide.md). No local Cargo patch/path dependency
should remain in these registry smoke checks. Archive-based package-check is
useful before publication but does not substitute for them.

Before npm publication or serving Wasm, inspect `pkg/NOTICE.taraba`,
`LICENSE.taraba`, `LICENSE.taraba-allocator` and `UPSTREAM.taraba-allocator.json`.
The source links describe the unmodified default allocator and memory_units.
When using a different version or modified MPL-covered source, provide the exact
corresponding source and update the notice. The application's license in
package.json is independent. Other dependencies require their own notices.
These files add package metadata bytes, not executable JS/Wasm bytes.
See [source/license provenance](../THIRD_PARTY.md).

Create release tags only for the verified commit after release authorization.
Record published crate versions and registry smoke results in the release notes.
