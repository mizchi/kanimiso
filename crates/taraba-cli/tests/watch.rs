use std::process::Command;

#[test]
fn watch_is_documented_and_cargo_options_are_scoped_to_project_watch() {
    let cli = env!("CARGO_BIN_EXE_taraba");
    let help = Command::new(cli).arg("--help").output().unwrap();
    assert!(String::from_utf8_lossy(&help.stdout).contains("--watch"));
    for args in [
        vec!["build", "--manifest-path", "Cargo.toml"],
        vec![
            "build",
            "raw.wasm",
            "--wit",
            "wit",
            "--watch",
            "--features",
            "std",
        ],
    ] {
        let output = Command::new(cli).args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("require project --watch"));
    }
}

#[test]
fn leading_profile_flags_are_checked_in_project_watch() {
    let output = Command::new(env!("CARGO_BIN_EXE_taraba"))
        .args([
            "build",
            "--future",
            "--jspi",
            "--watch",
            "--out-dir",
            "Cargo.toml",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot combine"));
}
