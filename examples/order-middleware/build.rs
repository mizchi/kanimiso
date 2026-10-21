fn main() {
    println!("cargo:rerun-if-changed=wit");
    println!("cargo:rerun-if-env-changed=TARABA_BINDGEN");
    if std::env::var_os("CARGO_FEATURE_CORE_RUNTIME").is_none() {
        return;
    }
    let cli = std::env::var_os("TARABA_BINDGEN").unwrap();
    println!(
        "cargo:rerun-if-changed={}",
        std::path::Path::new(&cli).display()
    );
    let status = std::process::Command::new(cli)
        .args([
            "bindgen",
            "--wit",
            "wit",
            "--world",
            if std::env::var_os("CARGO_FEATURE_MEASURED").is_some() {
                "measured"
            } else {
                "app"
            },
            "--out-dir",
        ])
        .arg(std::env::var_os("OUT_DIR").unwrap())
        .status()
        .unwrap();
    assert!(status.success());
}
