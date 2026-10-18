// wasm32 atomics is not exposed through cfg(target_feature) on every stable Rust.
// Check Cargo's effective flags as well; this script contributes no Wasm code.
fn main() {
    println!("cargo:rerun-if-env-changed=CARGO_ENCODED_RUSTFLAGS");
    let flags = std::env::var("CARGO_ENCODED_RUSTFLAGS").unwrap_or_default();
    if flags.contains("+atomics") || flags.contains("--shared-memory") {
        panic!("kanimiso-allocator supports non-shared single-thread Wasm only");
    }
}
