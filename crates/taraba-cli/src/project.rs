use std::{error::Error, fs, path::Path};
pub fn new_project(path: &Path, no_std: bool) -> Result<(), Box<dyn Error>> {
    new_jspi_project(path, no_std)
}
pub fn new_future_project(path: &Path, no_std: bool) -> Result<(), Box<dyn Error>> {
    scaffold(path, no_std, false)
}
pub fn new_jspi_project(path: &Path, no_std: bool) -> Result<(), Box<dyn Error>> {
    scaffold(path, no_std, true)
}
fn scaffold(path: &Path, no_std: bool, jspi: bool) -> Result<(), Box<dyn Error>> {
    if path.exists() {
        return Err("destination already exists".into());
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid project directory")?;
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || !name.starts_with(|c: char| c.is_ascii_alphabetic())
    {
        return Err(
            "project name must start with a letter and contain only ASCII letters, digits, - or _"
                .into(),
        );
    }
    fs::create_dir_all(path.join("src"))?;
    fs::create_dir_all(path.join("wit"))?;
    fs::write(
        path.join("Cargo.toml"),
        format!(
            r#"[package]
name = "{name}"
version = "0.1.0"
edition = "2024"
[lib]
crate-type = ["cdylib"]
[features]
default = [{default}]
std = [{std_feature}]
[dependencies]
{runtime_dependency}
taraba-allocator = {{version = "0.1.0", default-features = false}}
wit-bindgen = {{version = "=0.58.0", default-features = false, features = ["macros"]}}
[profile.release]
opt-level = "z"
lto = true
panic = "abort"
codegen-units = 1
"#,
            std_feature = if jspi { "" } else { "\"taraba/std\"" },
            runtime_dependency = if jspi {
                ""
            } else {
                "taraba = {version = \"0.1.0\", default-features = false}"
            },
            default = if no_std { "" } else { "\"std\"" }
        ),
    )?;
    fs::write(
        path.join("src/lib.rs"),
        if jspi {
            include_str!("templates/jspi.rs")
        } else {
            include_str!("templates/app.rs")
        },
    )?;
    fs::write(
        path.join("wit/app.wit"),
        if jspi {
            include_str!("templates/jspi.wit")
        } else {
            include_str!("templates/app.wit")
        },
    )?;
    fs::create_dir_all(path.join(".cargo"))?;
    fs::write(
        path.join(".cargo/config.toml"),
        "[target.wasm32-unknown-unknown]\nrustflags = [\"-C\", \"link-arg=-zstack-size=65536\", \"-C\", \"link-arg=--max-memory=1048576\"]\n",
    )?;
    fs::write(path.join(".gitignore"), "/target/\n/pkg/\n")?;
    println!(
        "Created {} ({}). Build with cargo build --release --target wasm32-unknown-unknown, then taraba build target/wasm32-unknown-unknown/release/{}.wasm --wit wit{}",
        path.display(),
        if no_std { "no_std" } else { "std" },
        name.replace('-', "_"),
        if jspi { "" } else { " --future" }
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scaffolds_registry_dependencies_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("hello");
        new_project(&path, true).unwrap();
        let manifest = fs::read_to_string(path.join("Cargo.toml")).unwrap();
        assert!(manifest.contains("version = \"0.1.0\""));
        assert!(!manifest.contains("path ="));
        assert!(new_project(&path, false).is_err());
        assert!(super::super::wit::parse(&path.join("wit"), None).is_ok());
    }
}
