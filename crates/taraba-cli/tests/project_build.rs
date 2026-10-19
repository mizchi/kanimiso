use std::{fs, process::Command};

#[test]
fn build_without_a_wasm_input_compiles_the_cargo_project() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("src")).unwrap();
    fs::write(
        root.path().join("Cargo.toml"),
        "[package]\nname='project-build'\nversion='0.1.0'\nedition='2024'\n[lib]\ncrate-type=['cdylib']\n[features]\nexample=[]\n",
    )
    .unwrap();
    fs::write(root.path().join("src/lib.rs"), "intentional Rust error").unwrap();
    for flags in [
        vec![],
        vec!["--features", "example", "--no-default-features"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_taraba"))
            .arg("build")
            .args(flags)
            .env("CARGO_TARGET_DIR", root.path().join("custom-target"))
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("cargo build failed"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!root.path().join("pkg").exists());
    }
}

#[test]
fn project_profile_conflicts_fail_before_cargo_or_output_changes() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_taraba"))
        .args(["build", "--future", "--jspi"])
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot combine"));
    assert!(!root.path().join("pkg").exists());
}
