//! Development orchestration. Generated JS/Wasm execution contracts stay in the library.
use crate::project_build::{
    Input, Options, Project, absolute, compile, project, publish, validate_output,
};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::{BTreeMap, HashSet},
    error::Error,
    fs,
    hash::Hasher,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
const QUIET: Duration = Duration::from_millis(150);

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
                        || s.starts_with(".taraba-build-")
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
            build(
                Input {
                    wasm,
                    wit,
                    npm: p.as_ref().map(|p| p.npm.clone()),
                },
                &stage,
            )?;
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
            root.join(".taraba-build-stage"),
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
