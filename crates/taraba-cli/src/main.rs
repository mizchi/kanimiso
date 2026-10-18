use std::path::{Path, PathBuf};
use taraba_cli::{BuildOptions, ExecutionProfile, build, new_future_project, new_project};

fn profile(args: &[String]) -> Result<ExecutionProfile, Box<dyn std::error::Error>> {
    let jspi = args.iter().any(|a| a == "--jspi");
    let future = args.iter().any(|a| a == "--future");
    if jspi && future {
        return Err("cannot combine --jspi and --future".into());
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
            "taraba new <directory> [--no-std] [--future | --jspi]\ntaraba build <raw.wasm> --wit <path> [--world <name>] [--out-dir pkg] [--debug] [--binaryen <bin-directory>] [--future | --jspi]\nDefault: JSPI scalar WIT (s32/u32/f64), Safari 27+ / JSPI-capable V8. Requires Binaryen 133. Calls serialize per instance; host rejection/traps close the instance; no cancellation. --jspi explicitly selects the default. --future selects the existing concurrent Rust Future / spawn_local / cancel runtime with imported resource handles. These contracts are different; no automatic fallback."
        ),
        Some("new") => {
            let profile = profile(args.get(2..).unwrap_or_default())?;
            for arg in args.iter().skip(2) {
                if !matches!(arg.as_str(), "--no-std" | "--jspi" | "--future") {
                    return Err(format!("unknown argument: {arg}").into());
                }
            }
            let path = Path::new(args.get(1).ok_or("missing directory")?);
            let no_std = args.contains(&"--no-std".into());
            match profile {
                ExecutionProfile::Jspi => new_project(path, no_std)?,
                ExecutionProfile::Future => new_future_project(path, no_std)?,
            }
        }
        Some("build") => {
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--wit" | "--world" | "--out-dir" | "--binaryen" => i += 2,
                    "--debug" | "--probes" | "--jspi" | "--future" => i += 1,
                    other => return Err(format!("unknown argument: {other}").into()),
                }
            }
            let profile = profile(args.get(2..).unwrap_or_default())?;
            build(&BuildOptions {
                input: PathBuf::from(args.get(1).ok_or("missing input Wasm")?),
                wit: PathBuf::from(value("--wit")?.ok_or("--wit is required")?),
                world: value("--world")?,
                output: PathBuf::from(value("--out-dir")?.unwrap_or_else(|| "pkg".into())),
                binaryen: value("--binaryen")?.map(PathBuf::from),
                debug: args.contains(&"--debug".into()),
                probes: args.contains(&"--probes".into()),
                profile,
            })?;
        }
        Some(other) => return Err(format!("unknown command {other}; use --help").into()),
    }
    Ok(())
}
