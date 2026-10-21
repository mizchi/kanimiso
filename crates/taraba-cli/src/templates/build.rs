fn main() {
    for key in ["TARABA_BINDGEN", "TARABA_WIT", "TARABA_WORLD"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let wit = std::env::var_os("TARABA_WIT").unwrap_or_else(|| "wit".into());
    println!(
        "cargo:rerun-if-changed={}",
        std::path::Path::new(&wit).display()
    );
    let cli = std::env::var_os("TARABA_BINDGEN").unwrap_or_else(|| "taraba".into());
    if std::path::Path::new(&cli).is_file() {
        println!(
            "cargo:rerun-if-changed={}",
            std::path::Path::new(&cli).display()
        );
    }
    let mut command = std::process::Command::new(cli);
    command
        .arg("bindgen")
        .arg("--wit")
        .arg(wit)
        .arg("--out-dir")
        .arg(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    if let Some(world) = std::env::var_os("TARABA_WORLD") {
        command.arg("--world").arg(world);
    }
    let status = command
        .status()
        .expect("run taraba bindgen (use taraba build or set TARABA_BINDGEN)");
    assert!(status.success(), "taraba bindgen failed");
}
