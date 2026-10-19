//! Cargo project discovery and builds shared by one-shot and watch commands.
use serde_json::Value;
use std::{
    error::Error,
    fs,
    io::{BufRead, BufReader},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
pub struct Options {
    pub input: Option<PathBuf>,
    pub wit: Option<PathBuf>,
    pub output: PathBuf,
    pub manifest: PathBuf,
    pub package: Option<String>,
    pub features: Option<String>,
    pub no_default_features: bool,
    pub size_warnings: bool,
}
pub struct Input {
    pub wasm: PathBuf,
    pub wit: PathBuf,
    pub npm: Option<taraba_cli::NpmOptions>,
}
pub(crate) struct Project {
    pub package: String,
    pub npm: taraba_cli::NpmOptions,
    pub manifest: PathBuf,
    pub root: PathBuf,
    pub target: PathBuf,
    pub sources: Vec<PathBuf>,
    pub source_root: PathBuf,
}

pub(crate) fn absolute(path: &Path) -> Result<PathBuf> {
    let mut resolved = PathBuf::new();
    // Resolve existing symlinks before '..', including when the final output does not exist yet.
    for part in std::path::absolute(path)?.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            part => resolved.push(part.as_os_str()),
        }
        if resolved.exists() {
            resolved = fs::canonicalize(resolved)?;
        }
    }
    Ok(resolved)
}

fn metadata(o: &Options, dependencies: bool, package: Option<&str>) -> Result<Value> {
    let mut command = Command::new("cargo");
    command.args(["metadata", "--format-version", "1", "--manifest-path"]);
    command.arg(&o.manifest);
    if dependencies {
        command.args(["--filter-platform", "wasm32-unknown-unknown"]);
        if let Some(features) = &o.features {
            let features = features
                .split([',', ' '])
                .filter(|s| !s.is_empty())
                .map(|f| {
                    if f.contains('/') {
                        f.to_owned()
                    } else {
                        format!("{}/{f}", package.unwrap())
                    }
                })
                .collect::<Vec<_>>()
                .join(",");
            command.args(["--features", &features]);
        }
        if o.no_default_features {
            command.arg("--no-default-features");
        }
    } else {
        command.arg("--no-deps");
    }
    let output = command.output()?;
    if !output.status.success() {
        return Err(format!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

pub(crate) fn project(o: &Options) -> Result<Project> {
    let data = metadata(o, false, None)?;
    let manifest = absolute(&o.manifest)?;
    let packages = data["packages"]
        .as_array()
        .ok_or("invalid Cargo metadata packages")?;
    let cdylib = |p: &&Value| {
        p["targets"].as_array().is_some_and(|ts| {
            ts.iter().any(|t| {
                t["crate_types"]
                    .as_array()
                    .is_some_and(|types| types.iter().any(|k| k == "cdylib"))
            })
        })
    };
    let candidates: Vec<_> = packages
        .iter()
        .filter(cdylib)
        .filter(|p| {
            if let Some(name) = &o.package {
                return p["name"].as_str() == Some(name);
            }
            let root_package = packages.iter().find(|p| {
                p["manifest_path"]
                    .as_str()
                    .is_some_and(|p| absolute(Path::new(p)).is_ok_and(|p| p == manifest))
            });
            if let Some(root) = root_package {
                *p == root
            } else {
                true
            }
        })
        .collect();
    if candidates.len() != 1 {
        return Err(
            "project build requires one cdylib package; use --package <name> for a workspace"
                .into(),
        );
    }
    let selected = candidates[0];
    let package = selected["name"]
        .as_str()
        .ok_or("invalid Cargo package name")?
        .to_owned();
    let manifest = absolute(Path::new(
        selected["manifest_path"]
            .as_str()
            .ok_or("invalid Cargo manifest")?,
    ))?;
    let full = metadata(o, true, Some(&package))?;
    if o.size_warnings {
        crate::diagnostics::warn_dependencies(
            &full,
            selected["id"].as_str().ok_or("invalid Cargo package id")?,
        );
    }
    let mut sources = vec![absolute(Path::new(
        full["workspace_root"]
            .as_str()
            .ok_or("invalid Cargo workspace")?,
    ))?];
    for p in full["packages"]
        .as_array()
        .ok_or("invalid Cargo packages")?
    {
        if p["source"].is_null() {
            let path = Path::new(
                p["manifest_path"]
                    .as_str()
                    .ok_or("invalid local manifest")?,
            );
            sources.push(absolute(
                path.parent().ok_or("invalid local package root")?,
            )?);
        }
    }
    Ok(Project {
        source_root: absolute(Path::new(
            selected["targets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| {
                    t["crate_types"]
                        .as_array()
                        .is_some_and(|ts| ts.iter().any(|t| t == "cdylib"))
                })
                .and_then(|t| t["src_path"].as_str())
                .ok_or("invalid cdylib source path")?,
        ))?
        .parent()
        .ok_or("invalid source root")?
        .to_owned(),
        npm: crate::npm::cargo_defaults(selected)?,
        package,
        root: manifest.parent().unwrap().to_owned(),
        manifest,
        target: absolute(Path::new(
            full["target_directory"]
                .as_str()
                .ok_or("invalid Cargo target directory")?,
        ))?,
        sources,
    })
}

pub(crate) fn compile(o: &Options, p: &Project) -> Result<PathBuf> {
    let mut command = Command::new("cargo");
    command
        .args([
            "build",
            "--release",
            "--lib",
            "--target",
            "wasm32-unknown-unknown",
            "--message-format=json-render-diagnostics",
            "--manifest-path",
        ])
        .arg(&o.manifest)
        .args(["--package", &p.package])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(features) = &o.features {
        command.args(["--features", features]);
    }
    if o.no_default_features {
        command.arg("--no-default-features");
    }
    let mut child = command.spawn()?;
    let mut artifact = None;
    let mut read_error = None;
    let mut diagnostics = crate::diagnostics::Config::default();
    for line in BufReader::new(child.stdout.take().unwrap()).lines() {
        let line = match line {
            Ok(line) => line,
            Err(e) => {
                read_error = Some(e);
                break;
            }
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            eprintln!("{line}");
            continue;
        };
        if message["reason"] == "compiler-message" {
            if let Some(text) = message["message"]["rendered"].as_str() {
                eprint!("{text}");
            }
        } else if message["reason"] == "compiler-artifact"
            && message["manifest_path"]
                .as_str()
                .is_some_and(|s| absolute(Path::new(s)).is_ok_and(|path| path == p.manifest))
        {
            diagnostics.features = message["features"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| f.as_str().map(str::to_owned))
                .collect();
            diagnostics.debug_assertions = message["profile"]["debug_assertions"]
                .as_bool()
                .unwrap_or(false);
            if let Some(files) = message["filenames"].as_array() {
                for file in files.iter().filter_map(Value::as_str) {
                    if file.ends_with(".wasm") {
                        artifact = Some(absolute(Path::new(file))?);
                    }
                }
            }
        }
    }
    let status = child.wait()?;
    if let Some(error) = read_error {
        return Err(error.into());
    }
    if !status.success() {
        return Err("cargo build failed".into());
    }
    let artifact = artifact.ok_or("cargo did not produce the selected cdylib Wasm artifact")?;
    if o.size_warnings {
        crate::diagnostics::warn_sources(&artifact, &p.source_root, &diagnostics);
    }
    Ok(artifact)
}

pub(crate) fn publish(stage: &Path, output: &Path, backup: &Path) -> Result<()> {
    let previous = output.exists();
    if previous {
        fs::rename(output, backup)?;
    }
    if let Err(e) = fs::rename(stage, output) {
        if previous {
            fs::rename(backup, output)?;
        }
        return Err(e.into());
    }
    Ok(())
}

pub(crate) fn validate_output(output: &Path) -> Result<()> {
    if !output.exists() {
        return Ok(());
    }
    if !output.is_dir() {
        return Err("build output must be a directory".into());
    }
    if fs::read_dir(output)?.next().is_some() {
        let info = fs::read(output.join("build.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        if !info.is_some_and(|i| {
            i["builder"].is_string()
                && matches!(
                    i["profile"].as_str(),
                    Some("wit-core-jspi" | "wit-core-externref" | "component")
                )
        }) {
            return Err("build output must be empty or contain taraba build.json; use a dedicated generated directory".into());
        }
    }
    Ok(())
}

pub fn run(o: Options, mut build: impl FnMut(Input, &Path) -> Result<()>) -> Result<()> {
    let p = project(&o)?;
    let output = absolute(&o.output)?;
    validate_output(&output)?;
    let default_wit = p.root.join("wit");
    let wit = absolute(o.wit.as_deref().unwrap_or(&default_wit))?;
    if p.sources.iter().any(|r| r.starts_with(&output))
        || p.root.starts_with(&output)
        || wit.starts_with(&output)
        || (wit.is_dir() && output.starts_with(&wit))
        || p.target.starts_with(&output)
    {
        return Err(
            "build output must not contain input sources or Cargo's target directory".into(),
        );
    }
    let wasm = compile(&o, &p)?;
    if wasm.starts_with(&output) {
        return Err("build output must not contain input Wasm".into());
    }
    let parent = output.parent().ok_or("invalid build output directory")?;
    fs::create_dir_all(parent)?;
    let temp = tempfile::Builder::new()
        .prefix(".taraba-build-")
        .tempdir_in(parent)?;
    let stage = temp.path().join("next");
    build(
        Input {
            wasm,
            wit,
            npm: Some(p.npm.clone()),
        },
        &stage,
    )?;
    publish(&stage, &output, &temp.path().join("previous"))?;
    eprintln!("taraba: build succeeded: {}", output.display());
    Ok(())
}
