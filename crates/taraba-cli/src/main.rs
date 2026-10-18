use std::path::{Path, PathBuf};
use taraba_cli::{
    BuildOptions, ComponentOptions, ExecutionProfile, NpmOptions, build, build_component,
    new_component_project, new_future_project, new_project, package_component, package_core,
};

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
            "taraba new <directory> [--no-std] [--component | --future | --jspi]\ntaraba build <raw.wasm> --wit <path> [--world <name>] [--out-dir pkg] [--binaryen <bin-directory>] [--component | --future | --jspi]\n  --component: standard Component Model / Canonical ABI, native WIT async and rich types; requires wasm-tools\n  --jspi (default): smallest scalar WIT/Core JSPI, serialized per instance; rejection/traps are fatal, no cancellation\n  --future: concurrent Rust Future / spawn_local / cancel runtime; opaque resource payloads\n  --npm-name <name> [--npm-version 0.1.0] [--license UNLICENSED]: generate an npm library with JS, Wasm, WIT-derived TypeScript and package.json; never publishes\n  --component --npm-name additionally requires jco (use --jco <executable>); generates standard jco bindings\n  --wasm-tools <executable>: component tool path\n  --debug / --probes: Core profiles only\nBinaryen 133. JavaScript async baseline: Safari 27+ / JSPI-capable V8. No automatic fallback between execution contracts."
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
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--wit" | "--world" | "--out-dir" | "--binaryen" | "--wasm-tools" | "--jco"
                    | "--npm-name" | "--npm-version" | "--license" => i += 2,
                    "--debug" | "--probes" | "--jspi" | "--future" | "--component" => i += 1,
                    other => return Err(format!("unknown argument: {other}").into()),
                }
            }
            let profile = profile(args.get(2..).unwrap_or_default())?;
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
            let o = BuildOptions {
                input: PathBuf::from(args.get(1).ok_or("missing input Wasm")?),
                wit: PathBuf::from(value("--wit")?.ok_or("--wit is required")?),
                world: value("--world")?,
                output: PathBuf::from(value("--out-dir")?.unwrap_or_else(|| "pkg".into())),
                binaryen: value("--binaryen")?.map(PathBuf::from),
                debug: args.contains(&"--debug".into()),
                probes: args.contains(&"--probes".into()),
                profile,
            };
            if component {
                let co = ComponentOptions {
                    input: o.input,
                    wit: o.wit,
                    world: o.world,
                    output: o.output,
                    binaryen: o.binaryen,
                    wasm_tools: PathBuf::from(
                        value("--wasm-tools")?.unwrap_or_else(|| "wasm-tools".into()),
                    ),
                };
                if let Some(npm) = npm {
                    package_component(
                        &co,
                        &npm,
                        Path::new(&value("--jco")?.unwrap_or_else(|| "jco".into())),
                    )?;
                } else {
                    build_component(&co)?;
                }
            } else if let Some(npm) = npm {
                package_core(&o, &npm)?;
            } else {
                build(&o)?;
            }
        }
        Some(other) => return Err(format!("unknown command {other}; use --help").into()),
    }
    Ok(())
}
