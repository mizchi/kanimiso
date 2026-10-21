use std::{fs, process::Command};

#[test]
fn taraba_cli_and_generated_projects_use_the_new_name() {
    let cli = env!("CARGO_BIN_EXE_taraba");
    let version = Command::new(cli).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout).unwrap(),
        format!("taraba {}\n", env!("CARGO_PKG_VERSION"))
    );
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
    let root = tempfile::tempdir().unwrap();
    for (command, expected) in [
        ("new", "missing directory"),
        ("build", "cargo metadata failed"),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_taraba"))
            .arg(command)
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8(output.stderr).unwrap().contains(expected));
    }
}

#[test]
fn component_projects_use_native_wit_async_without_the_core_runtime() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("component-library");
    let output = Command::new(env!("CARGO_BIN_EXE_taraba"))
        .arg("new")
        .arg(&path)
        .args(["--component", "--no-std"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let manifest = fs::read_to_string(path.join("Cargo.toml")).unwrap();
    assert!(manifest.contains("\"async\", \"async-spawn\""));
    assert!(!manifest.contains("\ntaraba ="));
    let source = fs::read_to_string(path.join("src/lib.rs")).unwrap();
    assert!(source.contains("async fn run"));
    assert!(source.contains("add(a, b).await"));
    assert!(!source.contains("unsafe"));
    let wit = fs::read_to_string(path.join("wit/app.wit")).unwrap();
    assert!(wit.contains("import add: async func"));
    assert!(wit.contains("export run: async func"));
    let tasks = fs::read_to_string(path.join("justfile")).unwrap();
    assert!(tasks.contains("--component"));
    assert!(tasks.contains("--npm-name"));
}

#[test]
fn component_profile_conflicts_fail_before_creating_a_project() {
    let root = tempfile::tempdir().unwrap();
    for other in ["--jspi", "--future"] {
        let path = root.path().join("invalid");
        let output = Command::new(env!("CARGO_BIN_EXE_taraba"))
            .arg("new")
            .arg(&path)
            .args(["--component", other])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("cannot combine"));
        assert!(!path.exists());
    }
}

#[test]
fn invalid_package_options_fail_without_writing_artifacts() {
    let root = tempfile::tempdir().unwrap();
    let out = root.path().join("pkg");
    for flags in [
        vec!["--npm-name", "BadName"],
        vec!["--npm-version", "v1.0.0"],
        vec!["--component", "--debug"],
        vec!["--jco", "jco"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_taraba"))
            .args(["build", "missing.wasm", "--wit", "missing.wit", "--out-dir"])
            .arg(&out)
            .args(flags)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!out.exists());
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("Binaryen"),
            "options should fail before running tools"
        );
    }
}
