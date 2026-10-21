fn main() {
    if std::env::var_os("CARGO_FEATURE_FUTURE_TYPED").is_none() {
        return;
    }
    println!("cargo:rerun-if-changed=wit");
    println!("cargo:rerun-if-env-changed=TARABA_BINDGEN");
    let cli = std::env::var_os("TARABA_BINDGEN")
        .expect("use just compare-async-size or set TARABA_BINDGEN");
    println!(
        "cargo:rerun-if-changed={}",
        std::path::Path::new(&cli).display()
    );
    let status = std::process::Command::new(cli)
        .arg("bindgen")
        .args([
            "--wit",
            if std::env::var_os("CARGO_FEATURE_ASYNC_WORKLOAD").is_some() {
                "wit/typed"
            } else {
                "wit/sync"
            },
            "--out-dir",
        ])
        .arg(std::env::var_os("OUT_DIR").unwrap())
        .status()
        .unwrap();
    assert!(status.success());
}
