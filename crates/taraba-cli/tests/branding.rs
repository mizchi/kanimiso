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
        } else {
            command.arg("--future");
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

#[test]
fn jspi_is_the_default_for_std_and_no_std_projects() {
    let root = tempfile::tempdir().unwrap();
    for no_std in [false, true] {
        let path = root
            .path()
            .join(if no_std { "minimal" } else { "standard" });
        let mut command = Command::new(env!("CARGO_BIN_EXE_taraba"));
        command.arg("new").arg(&path);
        if no_std {
            command.arg("--no-std");
        }
        let output = command.output().unwrap();
        assert!(output.status.success());
        let manifest = fs::read_to_string(path.join("Cargo.toml")).unwrap();
        assert!(!manifest.contains("\ntaraba ="));
        assert!(manifest.contains(if no_std {
            "default = []"
        } else {
            "default = [\"std\"]"
        }));
        let source = fs::read_to_string(path.join("src/lib.rs")).unwrap();
        assert!(!source.contains("future_to_promise"));
        assert!(
            fs::read_to_string(path.join("wit/app.wit"))
                .unwrap()
                .contains("-> s32")
        );
        assert!(!String::from_utf8(output.stdout).unwrap().contains("--jspi"));
    }
}

#[test]
fn conflicting_profiles_and_unknown_new_options_fail_before_creating_files() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("invalid");
    for flags in [vec!["--jspi", "--future"], vec!["--futuer"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_taraba"))
            .arg("new")
            .arg(&path)
            .args(flags)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!path.exists());
    }
    let output = Command::new(env!("CARGO_BIN_EXE_taraba"))
        .args([
            "build",
            "missing.wasm",
            "--wit",
            "missing.wit",
            "--jspi",
            "--future",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("cannot combine")
    );
}

#[test]
fn missing_command_inputs_report_errors_without_panicking() {
    for (command, expected) in [
        ("new", "missing directory"),
        ("build", "missing input Wasm"),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_taraba"))
            .arg(command)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8(output.stderr).unwrap().contains(expected));
    }
}
