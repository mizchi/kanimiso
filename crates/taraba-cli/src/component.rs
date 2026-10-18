//! Standard Component Model artifacts. Never applies the private Core ABI lowering.
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use wit_parser::{Resolve, WorldId, WorldItem};
type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub struct ComponentOptions {
    pub input: PathBuf,
    pub wit: PathBuf,
    pub world: Option<String>,
    pub output: PathBuf,
    pub binaryen: Option<PathBuf>,
    pub wasm_tools: PathBuf,
}
pub(crate) fn command(bin: &Path, args: &[&std::ffi::OsStr]) -> Result<Vec<u8>> {
    let output = Command::new(bin).args(args).output().map_err(|e| {
        format!(
            "{}: {e}; install the documented build tool or pass its path",
            bin.display()
        )
    })?;
    if !output.status.success() {
        return Err(format!(
            "{} failed: {}",
            bin.display(),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(output.stdout)
}
pub(crate) fn resolve(path: &Path, world: Option<&str>) -> Result<(Resolve, WorldId)> {
    let mut r = Resolve::default();
    let (pkg, _) = r.push_path(path)?;
    let world = r.select_world(&[pkg], world)?;
    Ok((r, world))
}
pub(crate) fn async_functions(r: &Resolve, world: WorldId, export: bool) -> Vec<String> {
    let items = if export {
        &r.worlds[world].exports
    } else {
        &r.worlds[world].imports
    };
    let mut names = Vec::new();
    for (key, item) in items {
        let mut add = |prefix: Option<String>, f: &wit_parser::Function| {
            if f.kind.is_async() {
                names.push(match prefix {
                    Some(p) => format!("{p}#{}", f.name),
                    None => f.name.clone(),
                });
            }
        };
        match item {
            WorldItem::Function(f) => add(None, f),
            WorldItem::Interface { id, .. } => {
                for f in r.interfaces[*id].functions.values() {
                    add(Some(r.name_world_key(key)), f);
                }
            }
            WorldItem::Type { .. } => {}
        }
    }
    names
}

/// Optimize a wit-bindgen guest, encode and validate a component, and verify its WIT world.
/// Requires Binaryen 133 and wasm-tools; does not transpile or publish a package.
pub fn build_component(o: &ComponentOptions) -> Result<()> {
    let (r, world) = resolve(&o.wit, o.world.as_deref())?;
    let opt = o
        .binaryen
        .clone()
        .or_else(|| std::env::var_os("TARABA_BINARYEN").map(PathBuf::from))
        .map(|p| p.join("wasm-opt"))
        .unwrap_or_else(|| "wasm-opt".into());
    let version = command(&opt, &["--version".as_ref()])?;
    if !String::from_utf8_lossy(&version)
        .split_whitespace()
        .any(|s| s == "133")
    {
        return Err("wasm-opt must be Binaryen 133".into());
    }
    let temp = tempfile::tempdir()?;
    let guest = temp.path().join("guest.wasm");
    let component = temp.path().join("app.component.wasm");
    let mut args: Vec<std::ffi::OsString> = vec![o.input.as_os_str().into()];
    args.extend(
        crate::build::optimization_flags()
            .into_iter()
            .map(Into::into),
    );
    args.extend(["-o".into(), guest.as_os_str().into()]);
    command(
        &opt,
        &args.iter().map(|s| s.as_os_str()).collect::<Vec<_>>(),
    )?;
    command(
        &o.wasm_tools,
        &[
            "component".as_ref(),
            "new".as_ref(),
            guest.as_os_str(),
            "-o".as_ref(),
            component.as_os_str(),
        ],
    )?;
    command(
        &o.wasm_tools,
        &[
            "validate".as_ref(),
            "--features".as_ref(),
            "cm-async".as_ref(),
            component.as_os_str(),
        ],
    )?;
    let selected = r.id_of_name(
        r.worlds[world].package.ok_or("world has no package")?,
        &r.worlds[world].name,
    );
    command(
        &o.wasm_tools,
        &[
            "component".as_ref(),
            "targets".as_ref(),
            o.wit.as_os_str(),
            component.as_os_str(),
            "--world".as_ref(),
            selected.as_ref(),
        ],
    )?;
    let wit = command(
        &o.wasm_tools,
        &["component".as_ref(), "wit".as_ref(), component.as_os_str()],
    )?;
    let bytes = fs::read(&component)?;
    if o.output.join("app.component.wasm").exists()
        && fs::canonicalize(o.output.join("app.component.wasm"))? == fs::canonicalize(&o.input)?
    {
        return Err("output must not overwrite input".into());
    }
    fs::create_dir_all(&o.output)?;
    fs::write(o.output.join("app.component.wasm"), &bytes)?;
    fs::write(o.output.join("app.wit"), wit)?;
    fs::write(
        o.output.join("build.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "builder":env!("CARGO_PKG_VERSION"), "profile":"component", "world":selected,
            "wasm_bytes":bytes.len(), "binaryen":133, "abi":"canonical", "native_wit_async":true
        }))?,
    )?;
    println!(
        "{}: {} B Component (Canonical ABI)",
        o.output.display(),
        bytes.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn async_selection_preserves_interface_names_and_excludes_sync_functions() {
        let mut r = Resolve::default();
        let pkg = r.push_str("app.wit", "package test:app@0.1.0; interface io { wait: async func(); now: func(); } world app { import io; import plain: func(); export run: async func(); }").unwrap();
        let w = r.select_world(&[pkg], None).unwrap();
        assert_eq!(async_functions(&r, w, false), ["test:app/io@0.1.0#wait"]);
        assert_eq!(async_functions(&r, w, true), ["run"]);
    }
}
