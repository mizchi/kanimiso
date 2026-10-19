use std::{fs, process::Command};

#[test]
fn update_check_is_read_only_and_compares_the_installed_cli_assets() {
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("pkg");
    fs::create_dir_all(output.join(".taraba")).unwrap();
    let path = output.join(".taraba/rebuild.json");
    let mut recipe = serde_json::json!({
        "schema": 1,
        "builder": env!("CARGO_PKG_VERSION"),
        "assets": serde_json::from_str::<serde_json::Value>(include_str!("../assets/provenance.json")).unwrap(),
        "cwd": root.path(),
        "args": []
    });
    fs::write(
        output.join("build.json"),
        r#"{"builder":"0.1.0","profile":"wit-core-jspi"}"#,
    )
    .unwrap();
    fs::write(output.join("index.js"), "keep existing output").unwrap();
    for state in ["current", "assets", "builder"] {
        if state == "assets" {
            recipe["assets"]["assets"]["taraba.mjs"] = "older asset hash".into();
        } else if state == "builder" {
            recipe["builder"] = "0.0.1".into();
        }
        let bytes = serde_json::to_vec(&recipe).unwrap();
        fs::write(&path, &bytes).unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_taraba"))
            .args(["update", "--check"])
            .current_dir(root.path())
            .output()
            .unwrap();
        assert_eq!(
            result.status.success(),
            state == "current",
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(
            fs::read_to_string(output.join("index.js")).unwrap(),
            "keep existing output"
        );
    }
}

#[test]
fn failed_regeneration_preserves_every_existing_output_file() {
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("pkg");
    fs::create_dir_all(output.join(".taraba")).unwrap();
    let info = r#"{"builder":"0.0.1","profile":"wit-core-jspi"}"#;
    let recipe = serde_json::to_vec(&serde_json::json!({
        "schema":1,"builder":env!("CARGO_PKG_VERSION"),"assets":{},"cwd":root.path(),
        "args":["missing.wasm","--wit","missing.wit"]
    }))
    .unwrap();
    fs::write(output.join("build.json"), info).unwrap();
    fs::write(output.join(".taraba/rebuild.json"), &recipe).unwrap();
    fs::write(output.join("index.js"), "keep existing output").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_taraba"))
        .arg("update")
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("previous output was preserved"));
    assert_eq!(fs::read_to_string(output.join("build.json")).unwrap(), info);
    assert_eq!(
        fs::read(output.join(".taraba/rebuild.json")).unwrap(),
        recipe
    );
    assert_eq!(
        fs::read_to_string(output.join("index.js")).unwrap(),
        "keep existing output"
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn unsupported_recipes_and_options_do_not_change_outputs() {
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("pkg");
    fs::create_dir_all(output.join(".taraba")).unwrap();
    let recipe = b"{\"schema\":99}";
    fs::write(output.join(".taraba/rebuild.json"), recipe).unwrap();
    for flags in [
        vec![],
        vec!["--out-dir"],
        vec!["--unknown"],
        vec!["--check"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_taraba"))
            .arg("update")
            .args(flags)
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert_eq!(
            fs::read(output.join(".taraba/rebuild.json")).unwrap(),
            recipe
        );
    }
}

#[test]
fn project_build_rejects_an_incompatible_renamed_runtime_before_compiling() {
    let root = tempfile::tempdir().unwrap();
    for path in ["src", "runtime/src"] {
        fs::create_dir_all(root.path().join(path)).unwrap();
    }
    fs::write(root.path().join("Cargo.toml"), "[package]\nname='app'\nversion='0.1.0'\nedition='2024'\n[lib]\ncrate-type=['cdylib']\n[dependencies]\njsrt={package='taraba',path='runtime'}\n").unwrap();
    fs::write(
        root.path().join("runtime/Cargo.toml"),
        "[package]\nname='taraba'\nversion='0.9.0'\nedition='2024'\n",
    )
    .unwrap();
    fs::write(root.path().join("runtime/src/lib.rs"), "").unwrap();
    fs::write(root.path().join("src/lib.rs"), "intentional Rust error").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_taraba"))
        .arg("build")
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("taraba 0.9.0 is incompatible"),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!root.path().join("pkg").exists());
}

#[test]
fn old_outputs_without_a_recipe_request_an_explicit_build() {
    let root = tempfile::tempdir().unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_taraba"))
        .arg("update")
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("taraba build"));
    assert!(!root.path().join("pkg").exists());
}
