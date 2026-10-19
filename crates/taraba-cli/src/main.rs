use std::path::{Path, PathBuf};
use taraba_cli::{
    BuildOptions, ComponentOptions, ExecutionProfile, NpmOptions, build, build_component,
    new_component_project, new_future_project, new_project, package_component, package_core,
};
mod watch;

fn profile(args: &[String]) -> Result<ExecutionProfile, Box<dyn std::error::Error>> {
    let jspi = args.iter().any(|a| a == "--jspi");
    let future = args.iter().any(|a| a == "--future");
    let component = args.iter().any(|a| a == "--component");
    if [jspi, future, component].iter().filter(|v| **v).count() > 1 {
        return Err("cannot combine --jspi, --future or --component".into());
    }
    Ok(if future {
        ExecutionProfile::Future
    } else {
        ExecutionProfile::default()
    })
}
fn main() {
    if let Err(e) = main_impl() {
        eprintln!("taraba: {e}");
        std::process::exit(1)
    }
}
fn main_impl() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| -> Result<Option<String>, Box<dyn std::error::Error>> {
        let Some(i) = args.iter().position(|a| a == flag) else {
            return Ok(None);
        };
        Ok(Some(
            args.get(i + 1)
                .filter(|a| !a.starts_with("--"))
                .ok_or_else(|| format!("missing value for {flag}"))?
                .clone(),
        ))
    };
    match args.first().map(String::as_str) {
        Some("--version") => println!("taraba {}", env!("CARGO_PKG_VERSION")),
        None | Some("--help") => println!(
            "taraba new <directory> [--no-std] [--component | --future | --jspi]\ntaraba build <raw.wasm> --wit <path> [--watch] [--world <name>] [--out-dir pkg] [--binaryen <bin-directory>] [--component | --future | --jspi]\ntaraba build --watch [--manifest-path Cargo.toml] [--package <name>] [--wit wit] [--features <list>] [--no-default-features]\n  --watch: rebuild on Rust/WIT/local dependency changes; Cargo release wasm32 builds without a Wasm input, otherwise watch the supplied Wasm/WIT; failed builds retain previous output\n  --component: standard Component Model / Canonical ABI, native WIT async and rich types; requires wasm-tools\n  --jspi (default): smallest scalar WIT/Core JSPI, serialized per instance; rejection/traps are fatal, no cancellation\n  --future: concurrent Rust Future / spawn_local / cancel runtime; opaque resource payloads\n  --npm-name <name> [--npm-version 0.1.0] [--license UNLICENSED]: generate an npm library with JS, Wasm, WIT-derived TypeScript and package.json; never publishes\n  --component --npm-name additionally requires jco (use --jco <executable>); generates standard jco bindings\n  --wasm-tools <executable>: component tool path\n  --debug / --probes: Core profiles only\nBinaryen 133. JavaScript async baseline: Safari 27+ / JSPI-capable V8. No automatic fallback between execution contracts."
        ),
        Some("new") => {
            let profile = profile(args.get(2..).unwrap_or_default())?;
            for arg in args.iter().skip(2) {
                if !matches!(
                    arg.as_str(),
                    "--no-std" | "--jspi" | "--future" | "--component"
                ) {
                    return Err(format!("unknown argument: {arg}").into());
                }
            }
            let path = Path::new(args.get(1).ok_or("missing directory")?);
            let no_std = args.contains(&"--no-std".into());
            if args.iter().any(|a| a == "--component") {
                new_component_project(path, no_std)?;
            } else {
                match profile {
                    ExecutionProfile::Jspi => new_project(path, no_std)?,
                    ExecutionProfile::Future => new_future_project(path, no_std)?,
                }
            }
        }
        Some("build") => {
            let input = args
                .get(1)
                .filter(|a| !a.starts_with("--"))
                .map(PathBuf::from);
            let watching = args.iter().any(|a| a == "--watch");
            let mut i = if input.is_some() { 2 } else { 1 };
            while i < args.len() {
                match args[i].as_str() {
                    "--wit" | "--world" | "--out-dir" | "--binaryen" | "--wasm-tools" | "--jco"
                    | "--npm-name" | "--npm-version" | "--license" | "--manifest-path"
                    | "--package" | "--features" => i += 2,
                    "--debug"
                    | "--probes"
                    | "--jspi"
                    | "--future"
                    | "--component"
                    | "--watch"
                    | "--no-default-features" => i += 1,
                    other => return Err(format!("unknown argument: {other}").into()),
                }
            }
            let manifest = value("--manifest-path")?;
            let package = value("--package")?;
            let features = value("--features")?;
            let no_default_features = args.iter().any(|a| a == "--no-default-features");
            if (manifest.is_some()
                || package.is_some()
                || features.is_some()
                || no_default_features)
                && (!watching || input.is_some())
            {
                return Err("--manifest-path / --package / --features / --no-default-features require project --watch without a Wasm input".into());
            }
            if input.is_none() && !watching {
                return Err("missing input Wasm".into());
            }
            let profile = profile(args.get(1..).unwrap_or_default())?;
            let component = args.iter().any(|a| a == "--component");
            let npm = value("--npm-name")?
                .map(|name| -> Result<_, Box<dyn std::error::Error>> {
                    Ok(NpmOptions {
                        name,
                        version: value("--npm-version")?.unwrap_or_else(|| "0.1.0".into()),
                        license: value("--license")?.unwrap_or_else(|| "UNLICENSED".into()),
                    })
                })
                .transpose()?;
            if let Some(npm) = &npm {
                npm.validate()?;
            }
            if npm.is_none() && (value("--npm-version")?.is_some() || value("--license")?.is_some())
            {
                return Err("--npm-version / --license require --npm-name".into());
            }
            if component
                && args
                    .iter()
                    .any(|a| matches!(a.as_str(), "--debug" | "--probes"))
            {
                return Err("--debug / --probes are Core-only options".into());
            }
            if !component && (value("--wasm-tools")?.is_some() || value("--jco")?.is_some()) {
                return Err("--wasm-tools / --jco require --component".into());
            }
            if npm.is_none() && value("--jco")?.is_some() {
                return Err("--jco requires --npm-name".into());
            }
            let wit = value("--wit")?.map(PathBuf::from);
            if wit.is_none() && input.is_some() {
                return Err("--wit is required".into());
            }
            let o = BuildOptions {
                input: input.clone().unwrap_or_default(),
                wit: wit.clone().unwrap_or_default(),
                world: value("--world")?,
                output: PathBuf::from(value("--out-dir")?.unwrap_or_else(|| "pkg".into())),
                binaryen: value("--binaryen")?.map(PathBuf::from),
                debug: args.contains(&"--debug".into()),
                probes: args.contains(&"--probes".into()),
                profile,
            };
            let wasm_tools =
                PathBuf::from(value("--wasm-tools")?.unwrap_or_else(|| "wasm-tools".into()));
            let jco = PathBuf::from(value("--jco")?.unwrap_or_else(|| "jco".into()));
            if watching {
                let watch = watch::Options {
                    input,
                    wit,
                    output: o.output.clone(),
                    manifest: PathBuf::from(manifest.unwrap_or_else(|| "Cargo.toml".into())),
                    package,
                    features,
                    no_default_features,
                };
                watch::run(watch, |input, output| {
                    let mut build = o.clone();
                    build.input = input.wasm;
                    build.wit = input.wit;
                    build.output = output.to_owned();
                    execute(build, npm.as_ref(), component, &wasm_tools, &jco)
                })?;
            } else {
                execute(o, npm.as_ref(), component, &wasm_tools, &jco)?;
            }
        }
        Some(other) => return Err(format!("unknown command {other}; use --help").into()),
    }
    Ok(())
}

fn execute(
    o: BuildOptions,
    npm: Option<&NpmOptions>,
    component: bool,
    wasm_tools: &Path,
    jco: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    if component {
        let co = ComponentOptions {
            input: o.input,
            wit: o.wit,
            world: o.world,
            output: o.output,
            binaryen: o.binaryen,
            wasm_tools: wasm_tools.to_owned(),
        };
        if let Some(npm) = npm {
            package_component(&co, npm, jco)
        } else {
            build_component(&co)
        }
    } else if let Some(npm) = npm {
        package_core(&o, npm)
    } else {
        build(&o)
    }
}
