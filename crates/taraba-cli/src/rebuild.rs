//! Local build recipes. Never included in generated npm packages.
use crate::project_build::{absolute, publish, validate_output};
use serde_json::Value;
use std::{error::Error, fs, path::Path, process::Command};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
const RECIPE: &str = ".taraba/rebuild.json";

fn assets() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "../assets/provenance.json"
    ))?)
}

struct Recipe {
    builder: String,
    assets: Value,
    cwd: std::path::PathBuf,
    args: Vec<String>,
}
impl Recipe {
    fn current(args: &[String]) -> Result<Self> {
        Ok(Self {
            builder: env!("CARGO_PKG_VERSION").into(),
            assets: assets()?,
            cwd: std::env::current_dir()?,
            args: args.iter().filter(|a| *a != "--watch").cloned().collect(),
        })
    }
    fn read(output: &Path) -> Result<Self> {
        let bytes = fs::read(output.join(RECIPE)).map_err(|_| {
            "missing local build recipe; run taraba build once with your original build options"
        })?;
        let data: Value = serde_json::from_slice(&bytes)?;
        if data["schema"] != 1 {
            return Err("unsupported local build recipe; rerun taraba build".into());
        }
        Ok(Self {
            builder: data["builder"]
                .as_str()
                .ok_or("invalid recipe builder")?
                .into(),
            assets: data
                .get("assets")
                .filter(|a| a.is_object())
                .ok_or("invalid recipe assets")?
                .clone(),
            cwd: data["cwd"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("invalid recipe directory")?
                .into(),
            args: data["args"]
                .as_array()
                .ok_or("invalid recipe arguments")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| "invalid recipe argument".into())
                })
                .collect::<Result<Vec<_>>>()?,
        })
    }
    fn write(&self, output: &Path) -> Result<()> {
        fs::create_dir_all(output.join(".taraba"))?;
        fs::write(
            output.join(RECIPE),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema":1,"builder":self.builder,"assets":self.assets,"cwd":self.cwd,"args":self.args
            }))?,
        )?;
        Ok(())
    }
    fn changed(&self) -> Result<bool> {
        Ok(self.builder != env!("CARGO_PKG_VERSION") || self.assets != assets()?)
    }
    fn staged_args(&self, stage: &Path, output: &Path) -> Result<Vec<String>> {
        let mut args = Vec::new();
        let mut original_output = None;
        let mut i = 0;
        while i < self.args.len() {
            match self.args[i].as_str() {
                "--watch" => {}
                "--out-dir" => {
                    i += 1;
                    let value = self.args.get(i).ok_or("invalid recipe --out-dir")?;
                    original_output.get_or_insert(value.as_str());
                }
                arg => args.push(arg.to_owned()),
            }
            i += 1;
        }
        // The recipe belongs to this local output. Copying an npm directory is
        // not enough to reconstruct its source project or relocate its inputs.
        if !self.cwd.is_absolute()
            || absolute(&self.cwd.join(original_output.unwrap_or("pkg")))? != output
        {
            return Err("local build recipe belongs to another output directory; rerun taraba build from the source project".into());
        }
        args.push("--out-dir".into());
        args.push(stage.to_str().ok_or("non-UTF8 output directory")?.into());
        Ok(args)
    }
}

pub fn record(output: &Path, args: &[String]) -> Result<()> {
    Recipe::current(args)?.write(output)
}

pub fn run(args: &[String]) -> Result<()> {
    if args == ["--help"] {
        println!(
            "taraba update [--out-dir pkg] [--check]\nRegenerate Wasm, JS and types together using the installed CLI and saved build options. --check is read-only and exits nonzero when an update is available. Upgrade the CLI separately with cargo install taraba-cli --locked --force. Rust dependencies follow Cargo.toml/Cargo.lock; this command does not change version requirements or publish."
        );
        return Ok(());
    }
    let mut output = std::path::PathBuf::from("pkg");
    let mut check = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--check" => check = true,
            "--out-dir" => {
                i += 1;
                output = args
                    .get(i)
                    .filter(|a| !a.starts_with("--"))
                    .ok_or("missing value for --out-dir")?
                    .into();
            }
            arg => return Err(format!("unknown update argument: {arg}").into()),
        }
        i += 1;
    }
    let output = absolute(&output)?;
    let mut recipe = Recipe::read(&output)?;
    validate_output(&output)?;
    if check {
        if recipe.changed()? {
            return Err(format!("update available: generator {} -> {}; run taraba update for the installed CLI's assets", recipe.builder, env!("CARGO_PKG_VERSION")).into());
        }
        println!(
            "taraba: generated assets match installed CLI {}",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    if recipe.args.first().is_some_and(|a| !a.starts_with("--"))
        && !crate::compatibility::same_line(&recipe.builder, env!("CARGO_PKG_VERSION"))?
    {
        return Err("raw Wasm crosses a CLI compatibility line; rebuild Rust with matching dependencies and rerun taraba build explicitly".into());
    }
    let parent = output.parent().ok_or("invalid build output directory")?;
    let temp = tempfile::Builder::new()
        .prefix(".taraba-build-")
        .tempdir_in(parent)?;
    let stage = temp.path().join("next");
    let status = Command::new(std::env::current_exe()?)
        .arg("build")
        .args(recipe.staged_args(&stage, &output)?)
        .current_dir(&recipe.cwd)
        .status()?;
    if !status.success() {
        return Err("update build failed; previous output was preserved".into());
    }
    recipe.builder = env!("CARGO_PKG_VERSION").into();
    recipe.assets = assets()?;
    recipe.args.retain(|a| a != "--watch");
    recipe.write(&stage)?;
    publish(&stage, &output, &temp.path().join("previous"))?;
    println!(
        "taraba: updated {} with CLI {}",
        output.display(),
        env!("CARGO_PKG_VERSION")
    );
    Ok(())
}
