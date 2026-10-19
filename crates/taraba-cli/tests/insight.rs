use std::{fs, process::Command};

#[test]
fn insight_reports_exact_sections_function_sizes_and_root_paths_without_changing_input() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("named.wasm");
    let bytes = wat::parse_str(
        r#"(module
      (import "jsrt" "__values" (table 1 externref))
      (func $fmt (result i32) i32.const 42)
      (func $run (export "run") (result i32) call $fmt)
      (memory 1) (data (i32.const 0) "hello")
    )"#,
    )
    .unwrap();
    fs::write(&path, &bytes).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_taraba"))
        .arg("insight")
        .arg(&path)
        .args(["--json", "--paths", "fmt"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["total_bytes"], bytes.len());
    assert_eq!(
        report["sections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["bytes"].as_u64().unwrap())
            .sum::<u64>()
            + 8,
        bytes.len() as u64
    );
    let functions = report["functions"].as_array().unwrap();
    assert_eq!(functions.len(), 1);
    assert_eq!(functions[0]["name"], "fmt");
    assert!(functions[0]["shallow_bytes"].as_u64().unwrap() > 0);
    assert_eq!(
        functions[0]["path"],
        serde_json::json!(["export run", "run", "fmt"])
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn insight_handles_stripped_names_and_rejects_invalid_arguments_and_binary() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("app.wasm");
    fs::write(
        &path,
        wat::parse_str("(module (func (export \"run\")))").unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_taraba"))
        .arg("insight")
        .arg(&path)
        .arg("--json")
        .output()
        .unwrap();
    assert!(result.status.success());
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["named_functions"], 0);
    assert!(
        report["notes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s.as_str().unwrap().contains("--insight"))
    );
    for args in [
        vec!["--top", "0"],
        vec!["--top", "nope"],
        vec!["--unknown"],
        vec!["--paths"],
    ] {
        assert!(
            !Command::new(env!("CARGO_BIN_EXE_taraba"))
                .arg("insight")
                .arg(&path)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    fs::write(&path, b"not wasm").unwrap();
    assert!(
        !Command::new(env!("CARGO_BIN_EXE_taraba"))
            .arg("insight")
            .arg(path)
            .output()
            .unwrap()
            .status
            .success()
    );
}
