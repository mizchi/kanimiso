use std::path::{Path, PathBuf};
use taraba_cli::{
    BuildOptions, ComponentOptions, ExecutionProfile, NpmOptions, build_component,
    detect_core_profile, new_component_project, new_future_project, new_project, package_component,
    package_core,
};
mod diagnostics;
mod insight_command;
mod npm;
mod project_build;
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
        Some("insight") => insight_command::run(&args[1..])?,
        None | Some("--help") => println!(
            "taraba insight [pkg | file.wasm] [--top 20] [--filter <substring>] [--retained] [--paths <substring>] [--json]\ntaraba new <directory> [--no-std] [--component | --future | --jspi]\ntaraba build <raw.wasm> --wit <path> [--watch] [--world <name>] [--out-dir pkg] [--binaryen <bin-directory>] [--component | --future | --jspi]\ntaraba build [--watch] [--manifest-path Cargo.toml] [--package <name>] [--wit wit] [--features <list>] [--no-default-features]\n  Without a Wasm input: compile the Cargo cdylib in release mode for wasm32-unknown-unknown; defaults: Cargo.toml, package wit/, pkg/ output\n  Core runtime: auto-detect JSPI/Future from compiled runtime imports/exports and WIT resources; explicit flags override\n  --watch: rebuild on Rust/WIT/local dependency changes; Cargo release wasm32 builds without a Wasm input, otherwise watch the supplied Wasm/WIT; failed builds retain previous output\n  --component: standard Component Model / Canonical ABI, native WIT async and rich types; requires wasm-tools\n  --jspi: force the scalar WIT/Core JSPI, serialized per instance; rejection/traps are fatal, no cancellation\n  --future: force the Rust Future / spawn_local / cancel runtime; opaque resource payloads\n  Core builds always generate pkg/index.js, index.d.ts and package.json; publish the pkg directory with npm/pnpm\n  --npm-name <name> / --npm-version <version> / --license <SPDX>: override Cargo package identity; raw Wasm defaults to its filename, 0.1.0, UNLICENSED; never publishes\n  --component --npm-name additionally requires jco (use --jco <executable>); generates standard jco bindings\n  --wasm-tools <executable>: component tool path\n  --debug / --probes: Core profiles only\n  --insight: retain optimized Core analysis under pkg/.taraba; excluded from npm packages\n  --no-size-warnings: suppress advisory formatting and dependency-size warnings (enabled by default)\nBinaryen 133. JavaScript async baseline: Safari 27+ / JSPI-capable V8. No automatic fallback between execution contracts."
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
                    "--insight" | "--no-size-warnings" => i += 1,
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
                && input.is_some()
            {
                return Err("--manifest-path / --package / --features / --no-default-features require a Cargo project without a Wasm input".into());
            }
            let profile = profile(args.get(1..).unwrap_or_default())?;
            let component = args.iter().any(|a| a == "--component");
            let automatic = !component
                && !args
                    .iter()
                    .any(|a| matches!(a.as_str(), "--jspi" | "--future"));
            let npm = npm::Overrides {
                name: value("--npm-name")?,
                version: value("--npm-version")?,
                license: value("--license")?,
            };
            npm.validate()?;
            if component && npm.name.is_none() && (npm.version.is_some() || npm.license.is_some()) {
                return Err("Component npm output requires --npm-name".into());
            }
            if component
                && args
                    .iter()
                    .any(|a| matches!(a.as_str(), "--debug" | "--probes" | "--insight"))
            {
                return Err("--debug / --probes / --insight are Core-only options".into());
            }
            if !component && (value("--wasm-tools")?.is_some() || value("--jco")?.is_some()) {
                return Err("--wasm-tools / --jco require --component".into());
            }
            if npm.name.is_none() && value("--jco")?.is_some() {
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
                insight: args.iter().any(|a| a == "--insight"),
                profile,
            };
            let wasm_tools =
                PathBuf::from(value("--wasm-tools")?.unwrap_or_else(|| "wasm-tools".into()));
            let jco = PathBuf::from(value("--jco")?.unwrap_or_else(|| "jco".into()));
            if watching || input.is_none() {
                let project = project_build::Options {
                    input,
                    wit,
                    output: o.output.clone(),
                    manifest: PathBuf::from(manifest.unwrap_or_else(|| "Cargo.toml".into())),
                    package,
                    features,
                    no_default_features,
                    size_warnings: !args.iter().any(|a| a == "--no-size-warnings"),
                };
                let generate = |input: project_build::Input, output: &Path| {
                    let package = if !component || npm.name.is_some() {
                        Some(npm.resolve(
                            input.npm.unwrap_or_else(|| npm::wasm_defaults(&input.wasm)),
                        )?)
                    } else {
                        None
                    };
                    let mut build = o.clone();
                    build.input = input.wasm;
                    build.wit = input.wit;
                    build.output = output.to_owned();
                    execute(
                        build,
                        package.as_ref(),
                        component,
                        automatic,
                        &wasm_tools,
                        &jco,
                        !args.iter().any(|a| a == "--no-size-warnings"),
                    )
                };
                if watching {
                    watch::run(project, generate)?;
                } else {
                    project_build::run(project, generate)?;
                }
            } else {
                let package = if !component || npm.name.is_some() {
                    Some(npm.resolve(npm::wasm_defaults(&o.input))?)
                } else {
                    None
                };
                execute(
                    o,
                    package.as_ref(),
                    component,
                    automatic,
                    &wasm_tools,
                    &jco,
                    !args.iter().any(|a| a == "--no-size-warnings"),
                )?;
            }
        }
        Some(other) => return Err(format!("unknown command {other}; use --help").into()),
    }
    Ok(())
}

fn execute(
    mut o: BuildOptions,
    npm: Option<&NpmOptions>,
    component: bool,
    automatic: bool,
    wasm_tools: &Path,
    jco: &Path,
    size_warnings: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if size_warnings {
        diagnostics::warn_wasm(&o.input);
    }
    if automatic {
        o.profile = if o.probes {
            ExecutionProfile::Future
        } else {
            detect_core_profile(&o)?
        };
        eprintln!(
            "taraba: selected {:?} from the guest runtime requirements",
            o.profile
        );
    }
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
    } else {
        let npm = npm.cloned().unwrap_or_else(|| npm::wasm_defaults(&o.input));
        package_core(&o, &npm)
    }
}
