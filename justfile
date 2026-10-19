default:
    @just --list

setup:
    pnpm install --frozen-lockfile
    rustup target add wasm32-unknown-unknown
    node tools/install-binaryen.mjs
    node tools/install-wasm-tools.mjs

build-host:
    pnpm build

build: build-host
    node tools/build-examples.mjs

test: build-host
    pnpm test
    cargo test --locked -p taraba --lib
    cargo test --locked -p taraba --lib --features std
    cargo test --locked -p taraba-cli
    cargo test --locked -p taraba-allocator --lib --features instrumentation,extra_assertions
    cargo test --locked -p taraba-allocator --lib --no-default-features --features instrumentation,extra_assertions

check: build test
    pnpm format:check
    cargo fmt --all -- --check
    cargo fmt --manifest-path verification/kani/models/Cargo.toml -- --check
    rustfmt --edition 2021 --check verification/kani/harnesses/*.rs
    node tools/check.mjs
    node tools/check-jspi.mjs
    node tools/check-library.mjs

library-check: build-host
    cargo build --locked --release -p taraba-cli
    node tools/check-library.mjs

prepare-async-size: build-host
    node tools/install-wasm-bindgen.mjs
    cargo fetch --locked --manifest-path experiments/async-size/Cargo.toml
    cargo fmt --manifest-path experiments/async-size/Cargo.toml --all -- --check
    pnpm exec prettier --check experiments/async-size/*.mjs experiments/async-size/bindgen/io.mjs
    cargo build --locked --release -p taraba-cli

compare-async-size: prepare-async-size
    node tools/compare-async-size.mjs

check-async-size: prepare-async-size
    node tools/compare-async-size.mjs --check

prepare-allocator:
    node tools/prepare-allocator.mjs
    cargo fetch --locked --manifest-path experiments/allocator/Cargo.toml
    cargo fmt --manifest-path experiments/allocator/Cargo.toml -- --check
    pnpm exec prettier --check experiments/allocator/*.mjs

compare-allocator: prepare-allocator
    node --no-liftoff tools/compare-allocator.mjs --require-improvement

check-allocator: prepare-allocator
    node --no-liftoff tools/compare-allocator.mjs --check --require-improvement

fmt:
    pnpm format
    cargo fmt --all
    cargo fmt --manifest-path verification/kani/models/Cargo.toml
    rustfmt --edition 2021 verification/kani/harnesses/*.rs
    cargo fmt --manifest-path experiments/async-size/Cargo.toml --all
    pnpm exec prettier --write experiments/async-size/*.mjs experiments/async-size/bindgen/io.mjs
    node tools/prepare-allocator.mjs
    cargo fmt --manifest-path experiments/allocator/Cargo.toml
    pnpm exec prettier --write experiments/allocator/*.mjs

stress seconds="60":
    node tools/stress.mjs {{seconds}}

miri:
    cargo +nightly miri test --locked -p taraba --lib -- --test-threads=1
    cargo +nightly miri test --locked -p taraba --lib --features std -- --test-threads=1
    cargo +nightly miri test --locked -p taraba-allocator --lib --no-default-features --features instrumentation -- --test-threads=1
    cargo +nightly miri test --locked -p taraba-allocator --lib --no-default-features --features instrumentation,extra_assertions test_merge_free_ -- --test-threads=1
    cargo +nightly miri test --locked -p taraba-allocator --lib --features instrumentation every_size_class_refills_one_fixed_slab -- --test-threads=1

kani-setup:
    cargo install --locked kani-verifier --version 0.67.0
    cargo kani setup

kani:
    node tools/prepare-kani.mjs
    cargo kani --manifest-path verification/kani/models/Cargo.toml --lib --output-format terse -Z unstable-options --harness-timeout 60s
    cargo kani --manifest-path .cache/kani/waker/Cargo.toml --lib --output-format terse -Z unstable-options --harness-timeout 60s
    cargo kani --manifest-path .cache/kani/allocator/Cargo.toml --lib --tests --exact --harness kani_proofs::checked_rounding_all_usize_values --harness kani_boundary_proofs::neighbor_tag_bits_preserve_every_aligned_u32_address --harness kani_boundary_proofs::valid_layouts_return_null_on_refill_oom_without_overflow --output-format terse -Z unstable-options --harness-timeout 60s

workers *args:
    node tools/workers.mjs {{args}}

modern:
    node tools/modern.mjs

kani-explore:
    cargo kani --manifest-path .cache/kani/allocator/Cargo.toml --lib --tests --exact --harness kani_proofs::adjacent_frees_coalesce_in_both_orders --harness kani_proofs::two_live_allocations_preserve_payload_and_alignment --output-format terse -Z unstable-options --harness-timeout 60s

report:
    node tools/report-verification.mjs

package-check: build-host
    node tools/package-check.mjs

compare-wit: build-host
    cargo fetch --locked --manifest-path experiments/wit/component-sync/Cargo.toml
    cargo fetch --locked --manifest-path experiments/wit/jspi/Cargo.toml
    cargo fetch --locked --manifest-path experiments/wit/core/Cargo.toml
    cargo fetch --locked --manifest-path experiments/wit/component/Cargo.toml
    cargo build --locked --release -p taraba-cli
    node tools/compare-wit.mjs

prepare-jspi-future: build-host
    cargo fetch --locked --manifest-path experiments/jspi-future/Cargo.toml
    cargo fetch --locked --manifest-path experiments/wit/jspi/Cargo.toml
    cargo fetch --locked --manifest-path experiments/wit/core/Cargo.toml
    cargo test --locked --manifest-path experiments/jspi-future/adapter/Cargo.toml
    cargo test --locked --manifest-path experiments/jspi-future/adapter/Cargo.toml --no-default-features --features bounded
    node --test experiments/jspi-future/*.test.mjs
    cargo fmt --manifest-path experiments/jspi-future/Cargo.toml --all -- --check
    pnpm exec prettier --check experiments/jspi-future/*.mjs
    cargo build --locked --release -p taraba-cli

experiment-jspi-future: prepare-jspi-future
    node tools/experiment-jspi-future.mjs

check-jspi-future: prepare-jspi-future
    node tools/experiment-jspi-future.mjs --check

miri-jspi-future:
    cargo +nightly miri test --locked --manifest-path experiments/jspi-future/adapter/Cargo.toml -- --test-threads=1

kani-jspi-future:
    cargo kani --manifest-path experiments/jspi-future/adapter/Cargo.toml --no-default-features --features bounded --lib --output-format terse -Z unstable-options --harness-timeout 60s

prepare-jspi-concurrent: check-jspi-future
    cargo fetch --locked --manifest-path experiments/jspi-concurrent/Cargo.toml
    cargo test --locked --manifest-path experiments/jspi-concurrent/Cargo.toml --bin transform
    cargo build --locked --manifest-path experiments/jspi-concurrent/Cargo.toml --bin transform
    node --test experiments/jspi-concurrent/*.test.mjs
    cargo fmt --manifest-path experiments/jspi-concurrent/Cargo.toml --all -- --check
    pnpm exec prettier --check experiments/jspi-concurrent/*.mjs

check-jspi-concurrent: prepare-jspi-concurrent
    node tools/experiment-jspi-concurrent.mjs --check

experiment-jspi-concurrent: prepare-jspi-concurrent
    node tools/experiment-jspi-concurrent.mjs
