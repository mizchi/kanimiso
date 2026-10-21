use std::{fs, process::Command};

#[test]
fn raw_wasm_abi_mismatch_fails_before_tools_or_output_changes() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("app.wit"),
        "package test:abi; world app {}",
    )
    .unwrap();
    let output = root.path().join("pkg");
    fs::create_dir(&output).unwrap();
    fs::write(output.join("keep"), "previous output").unwrap();
    for revision in [None, Some(999u32)] {
        let mut module = walrus::Module::from_buffer(
            &wat::parse_str("(module (func (export \"rt_poll\")))").unwrap(),
        )
        .unwrap();
        if let Some(revision) = revision {
            module.customs.add(walrus::RawCustomSection {
                name: "taraba:runtime-abi".into(),
                data: (revision << 16).to_le_bytes().to_vec(),
            });
        }
        fs::write(root.path().join("raw.wasm"), module.emit_wasm()).unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_taraba"))
            .args([
                "build",
                "raw.wasm",
                "--future",
                "--wit",
                "app.wit",
                "--binaryen",
                "missing-binaryen",
            ])
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(!result.status.success());
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(error.contains("runtime ABI"), "{error}");
        assert!(error.contains("runtime"), "{error}");
        assert_eq!(
            fs::read_to_string(output.join("keep")).unwrap(),
            "previous output"
        );
        assert!(!output.join("app.wasm").exists());
    }
}
