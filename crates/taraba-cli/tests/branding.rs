use std::{fs, process::Command};

#[test]
fn taraba_cli_and_generated_projects_use_the_new_name() {
    let cli = env!("CARGO_BIN_EXE_taraba");
    let version = Command::new(cli).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert_eq!(String::from_utf8(version.stdout).unwrap(), "taraba 0.1.0\n");
    let help = Command::new(cli).arg("--help").output().unwrap();
    assert!(help.status.success());
    assert!(
        String::from_utf8(help.stdout)
            .unwrap()
            .contains("taraba build")
    );
    let root = tempfile::tempdir().unwrap();
    for jspi in [false, true] {
        let path = root.path().join(if jspi { "scalar" } else { "future" });
        let mut command = Command::new(cli);
        command.arg("new").arg(&path).arg("--no-std");
        if jspi {
            command.arg("--jspi");
        }
        assert!(command.status().unwrap().success());
        let manifest = fs::read_to_string(path.join("Cargo.toml")).unwrap();
        assert!(manifest.contains("taraba-allocator ="));
        assert_eq!(manifest.contains("\ntaraba ="), !jspi);
        assert!(
            fs::read_to_string(path.join("src/lib.rs"))
                .unwrap()
                .contains("taraba_allocator::Allocator")
        );
        assert!(
            fs::read_to_string(path.join("wit/app.wit"))
                .unwrap()
                .starts_with("package taraba:app@")
        );
    }
}
