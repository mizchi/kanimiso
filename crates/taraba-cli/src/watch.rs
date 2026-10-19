//! Development orchestration. Generated JS/Wasm execution contracts stay in the library.
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    error::Error,
    fs,
    hash::Hasher,
    io::{BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
const QUIET: Duration = Duration::from_millis(150);

pub struct Options {
    pub input: Option<PathBuf>,
    pub wit: Option<PathBuf>,
    pub output: PathBuf,
    pub manifest: PathBuf,
    pub package: Option<String>,
    pub features: Option<String>,
    pub no_default_features: bool,
}
pub struct Input {
    pub wasm: PathBuf,
    pub wit: PathBuf,
}
struct Project {
    package: String,
    manifest: PathBuf,
    root: PathBuf,
    target: PathBuf,
    sources: Vec<PathBuf>,
}

fn absolute(path: &Path) -> Result<PathBuf> {
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

fn project(o: &Options) -> Result<Project> {
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
            "project watch requires one cdylib package; use --package <name> for a workspace"
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

fn compile(o: &Options, p: &Project) -> Result<PathBuf> {
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
    artifact.ok_or_else(|| "cargo did not produce the selected cdylib Wasm artifact".into())
}

struct Sources {
    roots: Vec<PathBuf>,
    excluded: Vec<PathBuf>,
}
impl Sources {
    fn ignored(&self, path: &Path) -> bool {
        self.excluded.iter().any(|p| path.starts_with(p))
            || self
                .roots
                .iter()
                .filter_map(|root| path.strip_prefix(root).ok())
                .min_by_key(|p| p.components().count())
                .unwrap_or_else(|| Path::new(path.file_name().unwrap_or_default()))
                .components()
                .any(|c| {
                    let Component::Normal(s) = c else {
                        return false;
                    };
                    let s = s.to_string_lossy();
                    matches!(s.as_ref(), ".git" | "node_modules" | ".cache")
                        || s.starts_with(".taraba-watch-")
                })
    }
    fn relevant(&self, event: &Event) -> bool {
        !event.kind.is_access() && event.paths.iter().any(|p| !self.ignored(p))
    }
    fn scan(&self) -> Result<(BTreeMap<PathBuf, u64>, HashSet<PathBuf>)> {
        fn visit(
            s: &Sources,
            path: &Path,
            files: &mut BTreeMap<PathBuf, u64>,
            dirs: &mut HashSet<PathBuf>,
            seen: &mut HashSet<PathBuf>,
        ) -> Result<()> {
            if s.ignored(path) {
                return Ok(());
            }
            let path = match fs::canonicalize(path) {
                Ok(path) => path,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(e.into()),
            };
            if s.ignored(&path) || !seen.insert(path.clone()) {
                return Ok(());
            }
            if path.is_dir() {
                dirs.insert(path.clone());
                for entry in fs::read_dir(path)? {
                    visit(s, &entry?.path(), files, dirs, seen)?;
                }
            } else if path.is_file() {
                let mut hash = std::hash::DefaultHasher::new();
                let mut file = match fs::File::open(&path) {
                    Ok(file) => file,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                    Err(e) => return Err(e.into()),
                };
                let mut buffer = [0; 8192];
                loop {
                    let n = file.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    hash.write(&buffer[..n]);
                }
                files.insert(path, hash.finish());
            }
            Ok(())
        }
        let (mut files, mut dirs, mut seen) = (BTreeMap::new(), HashSet::new(), HashSet::new());
        for root in &self.roots {
            // Watch parents too: deletion, atomic rename and later recreation of roots must recover.
            let mut parent = root.parent();
            while let Some(p) = parent {
                if p.is_dir() {
                    dirs.insert(p.to_owned());
                    break;
                }
                parent = p.parent();
            }
            visit(self, root, &mut files, &mut dirs, &mut seen)?;
        }
        Ok((files, dirs))
    }
}

fn register(
    watcher: &mut RecommendedWatcher,
    current: &mut HashSet<PathBuf>,
    wanted: HashSet<PathBuf>,
) -> Result<()> {
    for p in current.difference(&wanted) {
        let _ = watcher.unwatch(p);
    }
    for p in wanted.difference(current) {
        watcher.watch(p, RecursiveMode::NonRecursive)?;
    }
    *current = wanted;
    Ok(())
}
fn wait(
    rx: &Receiver<notify::Result<Event>>,
    sources: &Sources,
    stopped: &AtomicBool,
) -> Result<()> {
    loop {
        if stopped.load(Ordering::Relaxed) {
            return Ok(());
        }
        match rx.recv_timeout(QUIET) {
            Ok(Ok(e)) if sources.relevant(&e) => break,
            Ok(Err(e)) => {
                eprintln!("taraba: watch notification error: {e}; rescanning");
                break;
            }
            Ok(_) | Err(RecvTimeoutError::Timeout) => {}
            Err(e) => return Err(e.into()),
        }
    }
    let mut deadline = Instant::now() + QUIET;
    loop {
        if stopped.load(Ordering::Relaxed) {
            return Ok(());
        }
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Ok(e)) if sources.relevant(&e) => deadline = Instant::now() + QUIET,
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    }
}
fn publish(stage: &Path, output: &Path, backup: &Path) -> Result<()> {
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

fn validate_output(output: &Path) -> Result<()> {
    if !output.exists() {
        return Ok(());
    }
    if !output.is_dir() {
        return Err("watch output must be a directory".into());
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
            return Err("watch output must be empty or contain taraba build.json; use a dedicated generated directory".into());
        }
    }
    Ok(())
}

pub fn run(o: Options, mut build: impl FnMut(Input, &Path) -> Result<()>) -> Result<()> {
    let stopped = Arc::new(AtomicBool::new(false));
    let signal = stopped.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))?;
    let output = absolute(&o.output)?;
    validate_output(&output)?;
    let raw = o.input.as_deref().map(absolute).transpose()?;
    let manifest = absolute(&o.manifest)?;
    let initial = if raw.is_none() {
        Some(project(&o)?)
    } else {
        None
    };
    let mut sources = Sources {
        roots: vec![],
        excluded: vec![output.clone()],
    };
    let configure = |p: Option<&Project>| -> Result<(Sources, PathBuf)> {
        let default_wit = p
            .map(|p| p.root.join("wit"))
            .unwrap_or_else(|| PathBuf::from("wit"));
        let wit = absolute(o.wit.as_deref().unwrap_or(&default_wit))?;
        let mut roots = p.map(|p| p.sources.clone()).unwrap_or_default();
        if let Some(raw) = &raw {
            roots.push(raw.clone());
        }
        // A single WIT file can import dependencies alongside it.
        roots.push(if wit.is_file() {
            wit.parent().unwrap().to_owned()
        } else {
            wit.clone()
        });
        if raw.is_none() {
            roots.push(manifest.clone());
        }
        if roots.iter().any(|r| r.starts_with(&output))
            || (wit.is_dir() && output.starts_with(&wit))
            || p.is_some_and(|p| p.target.starts_with(&output))
        {
            return Err(
                "watch output must not contain input sources or Cargo's target directory".into(),
            );
        }
        let mut excluded = vec![output.clone()];
        if let Some(p) = p {
            excluded.push(p.target.clone());
        }
        Ok((Sources { roots, excluded }, wit))
    };
    let (configured, _) = configure(initial.as_ref())?;
    sources.roots = configured.roots;
    sources.excluded = configured.excluded;
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)?;
    let (mut observed, dirs) = sources.scan()?;
    let mut watched = HashSet::new();
    register(&mut watcher, &mut watched, dirs)?;
    loop {
        if stopped.load(Ordering::Relaxed) {
            return Ok(());
        }
        let result = (|| -> Result<()> {
            let p = if raw.is_none() {
                Some(project(&o)?)
            } else {
                None
            };
            let (configured, wit) = configure(p.as_ref())?;
            sources = configured;
            let (files, dirs) = sources.scan()?;
            register(&mut watcher, &mut watched, dirs)?;
            observed = files;
            let wasm = if let Some(raw) = &raw {
                raw.clone()
            } else {
                compile(&o, p.as_ref().unwrap())?
            };
            if wasm.starts_with(&output) {
                return Err("watch output must not contain input Wasm".into());
            }
            let parent = output.parent().ok_or("invalid watch output directory")?;
            fs::create_dir_all(parent)?;
            let temp = tempfile::Builder::new()
                .prefix(".taraba-watch-")
                .tempdir_in(parent)?;
            let stage = temp.path().join("next");
            build(Input { wasm, wit }, &stage)?;
            publish(&stage, &output, &temp.path().join("previous"))?;
            Ok(())
        })();
        match result {
            Ok(()) => eprintln!("taraba: watch build succeeded: {}", output.display()),
            Err(e) => eprintln!("taraba: watch build failed: {e}; keeping previous output"),
        }
        eprintln!("taraba: watching for changes (Ctrl-C to stop)");
        loop {
            wait(&rx, &sources, &stopped)?;
            if stopped.load(Ordering::Relaxed) {
                return Ok(());
            }
            match sources.scan() {
                Ok((files, dirs)) => {
                    register(&mut watcher, &mut watched, dirs)?;
                    if files != observed {
                        observed = files;
                        break;
                    }
                }
                Err(e) => eprintln!("taraba: watch scan failed: {e}; waiting for changes"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_output_components_cannot_hide_a_parent_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = absolute(temp.path()).unwrap();
        assert_eq!(absolute(&root.join("missing/..")).unwrap(), root);
    }

    #[test]
    fn snapshot_uses_contents_and_prunes_outputs_and_dependency_caches() {
        let temp = tempfile::tempdir().unwrap();
        let root = absolute(temp.path()).unwrap();
        let output = root.join("pkg");
        fs::write(root.join("input.rs"), "one").unwrap();
        let sources = Sources {
            roots: vec![root.clone()],
            excluded: vec![output.clone()],
        };
        let first = sources.scan().unwrap().0;
        for dir in [
            output,
            root.join("node_modules"),
            root.join(".git"),
            root.join(".taraba-watch-stage"),
        ] {
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("ignored"), "noise").unwrap();
        }
        assert_eq!(sources.scan().unwrap().0, first);
        fs::write(root.join("input.rs"), "two").unwrap();
        assert_ne!(sources.scan().unwrap().0, first);
    }

    #[test]
    fn explicit_inputs_under_a_cache_directory_are_still_observed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".cache");
        fs::create_dir(&root).unwrap();
        let file = root.join("input.wasm");
        fs::write(&file, "wasm").unwrap();
        let sources = Sources {
            roots: vec![absolute(&file).unwrap()],
            excluded: vec![],
        };
        assert_eq!(sources.scan().unwrap().0.len(), 1);
    }

    #[test]
    fn failed_publish_restores_the_previous_directory() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("pkg");
        fs::create_dir(&output).unwrap();
        fs::write(output.join("previous"), "last successful build").unwrap();
        assert!(
            publish(
                &temp.path().join("missing"),
                &output,
                &temp.path().join("backup")
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(output.join("previous")).unwrap(),
            "last successful build"
        );
    }

    #[test]
    fn a_nonempty_source_directory_is_not_a_generated_output() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("lib.rs"), "valuable source").unwrap();
        assert!(validate_output(temp.path()).is_err());
        assert_eq!(
            fs::read_to_string(temp.path().join("lib.rs")).unwrap(),
            "valuable source"
        );
    }
}
