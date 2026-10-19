default:
    @just --list

setup:
    pnpm install --frozen-lockfile
    rustup target add wasm32-unknown-unknown
    node tools/install-binaryen.mjs
    node tools/install-wasm-tools.mjs

build-host:
    pnpm build

# Install Rust 1.85.0 and its Wasm target before running this task.
msrv-check:
    cargo +1.85.0 check --locked -p taraba-cli
    cargo +1.85.0 check --locked --target wasm32-unknown-unknown -p taraba -p taraba-allocator -p taraba-helpers
    cargo +1.85.0 check --locked --target wasm32-unknown-unknown -p taraba -p taraba-allocator -p taraba-helpers --all-features

build: build-host
    node tools/build-examples.mjs

test: build-host
    pnpm test
    cargo test --locked -p taraba --lib
    cargo test --locked -p taraba --lib --features std
    cargo test --locked -p taraba-helpers --all-features --lib
    cargo test --locked -p taraba-cli
    cargo test --locked -p taraba-allocator --lib --features instrumentation,extra_assertions
    cargo test --locked -p taraba-allocator --lib --no-default-features --features instrumentation,extra_assertions
    cargo test --locked -p taraba-allocator --lib --features instrumentation,extra_assertions,realloc_in_place
    cargo test --locked -p taraba-allocator --lib --no-default-features --features instrumentation,extra_assertions,realloc_in_place

check: build test
    pnpm format:check
    cargo fmt --all -- --check
    cargo fmt --manifest-path verification/kani/models/Cargo.toml -- --check
    rustfmt --edition 2021 --config skip_children=true --check verification/kani/harnesses/*.rs
    node tools/check.mjs
    node tools/check-jspi.mjs
    node tools/check-panic.mjs
    node tools/check-insight.mjs
    node tools/check-helpers.mjs
    node tools/check-strings.mjs
    node tools/check-library.mjs
    node tools/check-watch.mjs

library-check: build-host
    cargo build --locked --release -p taraba-cli
    node tools/check-library.mjs

panic-check: build-host
    cargo build --locked --release -p taraba-cli
    node tools/check-panic.mjs

insight-check: build-host
    cargo build --locked --release -p taraba-cli
    node tools/check-insight.mjs

helpers-check: build-host
    cargo build --locked --release -p taraba-cli
    node tools/check-helpers.mjs
    node tools/check-strings.mjs

strings-check: build-host
    cargo build --locked --release -p taraba-cli
    node tools/check-strings.mjs

compare-strings: build-host
    cargo build --locked --release -p taraba-cli
    node tools/check-strings.mjs --snapshot

compare-helpers: build-host
    cargo build --locked --release -p taraba-cli
    node tools/check-helpers.mjs --snapshot

watch-check: build-host
    cargo build --locked --release -p taraba-cli
    node tools/check-watch.mjs

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

compare-frontend-size:
    node tools/measure-frontend-size.mjs

analyze-wasm-size: compare-async-size
    node tools/install-wasm-size-tools.mjs
    node tools/analyze-wasm-size.mjs

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
    rustfmt --edition 2021 --config skip_children=true verification/kani/harnesses/*.rs
    cargo fmt --manifest-path experiments/async-size/Cargo.toml --all
    pnpm exec prettier --write experiments/async-size/*.mjs experiments/async-size/bindgen/io.mjs
    node tools/prepare-allocator.mjs
    cargo fmt --manifest-path experiments/allocator/Cargo.toml
    pnpm exec prettier --write experiments/allocator/*.mjs

stress seconds="60":
    node tools/stress.mjs {{seconds}}

miri:
    cargo +nightly miri test --locked -p taraba-helpers --all-features --lib -- --test-threads=1
    cargo +nightly miri test --locked -p taraba --lib -- --test-threads=1
    cargo +nightly miri test --locked -p taraba --lib --features std -- --test-threads=1
    cargo +nightly miri test --locked -p taraba-allocator --lib --no-default-features --features instrumentation -- --test-threads=1
    cargo +nightly miri test --locked -p taraba-allocator --lib --no-default-features --features instrumentation,extra_assertions test_merge_free_ -- --test-threads=1
    cargo +nightly miri test --locked -p taraba-allocator --lib --features instrumentation every_size_class_refills_one_fixed_slab -- --test-threads=1
    cargo +nightly miri test --locked -p taraba-allocator --lib --features instrumentation,realloc_in_place regression:: -- --test-threads=1
    cargo +nightly miri test --locked -p taraba-allocator --lib --no-default-features --features instrumentation,realloc_in_place regression:: -- --test-threads=1

kani-setup:
    cargo install --locked kani-verifier --version 0.67.0
    cargo kani setup

kani:
    node tools/prepare-kani.mjs
    cargo kani --manifest-path verification/kani/models/Cargo.toml --lib --output-format terse -Z unstable-options --harness-timeout 60s
    cargo kani --manifest-path .cache/kani/waker/Cargo.toml --lib --output-format terse -Z unstable-options --harness-timeout 60s
    cargo kani --manifest-path .cache/kani/promise/Cargo.toml --lib --output-format terse -Z unstable-options --harness-timeout 60s
    cargo kani --manifest-path .cache/kani/regexp/Cargo.toml --lib --output-format terse -Z unstable-options --harness-timeout 60s
    cargo kani --manifest-path .cache/kani/iterator/Cargo.toml --lib --output-format terse -Z unstable-options --harness-timeout 60s
    cargo kani --manifest-path .cache/kani/allocator/Cargo.toml --lib --tests --exact --harness kani_proofs::checked_rounding_all_usize_values --harness kani_boundary_proofs::neighbor_tag_bits_preserve_every_aligned_u32_address --harness kani_boundary_proofs::valid_layouts_return_null_on_refill_oom_without_overflow --output-format terse -Z unstable-options --harness-timeout 60s
    cargo kani --manifest-path .cache/kani/allocator/Cargo.toml --lib --tests --features realloc_in_place --exact --harness kani_proofs::realloc_fast_path_preserves_word_class --output-format terse -Z unstable-options --harness-timeout 60s

workers *args:
    node tools/workers.mjs {{args}}

modern:
    node tools/modern.mjs

kani-explore:
    cargo kani --manifest-path .cache/kani/allocator/Cargo.toml --lib --tests --exact --harness kani_proofs::adjacent_frees_coalesce_in_both_orders --harness kani_proofs::two_live_allocations_preserve_payload_and_alignment --output-format terse -Z unstable-options --harness-timeout 60s

kani-realloc-explore:
    node tools/prepare-kani.mjs
    cargo kani --manifest-path .cache/kani/allocator/Cargo.toml --lib --tests --features realloc_in_place --exact --harness kani_proofs::native_same_word_realloc_preserves_prefix --output-format terse -Z unstable-options --harness-timeout 60s

report:
    node tools/report-verification.mjs

package-check *args: build-host
    node tools/package-check.mjs {{args}}

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
