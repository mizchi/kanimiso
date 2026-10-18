fn main() {
    println!("cargo:rerun-if-env-changed=CARGO_ENCODED_RUSTFLAGS");
    let flags = std::env::var("CARGO_ENCODED_RUSTFLAGS").unwrap_or_default();
    assert!(
        !flags.contains("+atomics") && !flags.contains("--shared-memory"),
        "js-local runtime requires non-shared single-agent Wasm"
    );
}
