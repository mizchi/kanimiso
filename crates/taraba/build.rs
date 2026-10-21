fn main() {
    println!("cargo:rustc-check-cfg=cfg(kani)");
    println!("cargo:rerun-if-env-changed=TARABA_TASK_SLOTS");
    let slots: usize = std::env::var("TARABA_TASK_SLOTS")
        .map(|s| s.parse().expect("TARABA_TASK_SLOTS must be an integer"))
        .unwrap_or(1024);
    assert!(
        (1..=65536).contains(&slots),
        "TARABA_TASK_SLOTS must be 1..=65536"
    );
    std::fs::write(
        std::path::Path::new(&std::env::var_os("OUT_DIR").unwrap()).join("slots.rs"),
        format!("pub(crate) const TASK_SLOTS:usize={slots};\n"),
    )
    .unwrap();
    println!("cargo:rerun-if-env-changed=CARGO_ENCODED_RUSTFLAGS");
    let flags = std::env::var("CARGO_ENCODED_RUSTFLAGS").unwrap_or_default();
    assert!(
        !flags.contains("+atomics") && !flags.contains("--shared-memory"),
        "js-local runtime requires non-shared single-agent Wasm"
    );
}
