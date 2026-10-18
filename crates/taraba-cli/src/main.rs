use std::path::{Path, PathBuf};
use taraba_cli::{BuildOptions, build, new_jspi_project, new_project};
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
            "taraba new <directory> [--no-std] [--jspi]\ntaraba build <raw.wasm> --wit <path> [--world <name>] [--out-dir pkg] [--debug] [--binaryen <bin-directory>] [--jspi]\nRequires Binaryen 133. WIT Core profile: s32/u32/f64 and imported resource handles; Promise resources map to native JS Promises. --jspi uses scalar WIT functions with serialized JSPI entry (Safari 27+)."
        ),
        Some("new") => {
            let path = Path::new(args.get(1).ok_or("missing directory")?);
            let no_std = args.contains(&"--no-std".into());
            if args.contains(&"--jspi".into()) {
                new_jspi_project(path, no_std)?;
            } else {
                new_project(path, no_std)?;
            }
        }
        Some("build") => {
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--wit" | "--world" | "--out-dir" | "--binaryen" => i += 2,
                    "--debug" | "--probes" | "--jspi" => i += 1,
                    other => return Err(format!("unknown argument: {other}").into()),
                }
            }
            build(&BuildOptions {
                input: PathBuf::from(args.get(1).ok_or("missing input Wasm")?),
                wit: PathBuf::from(value("--wit")?.ok_or("--wit is required")?),
                world: value("--world")?,
                output: PathBuf::from(value("--out-dir")?.unwrap_or_else(|| "pkg".into())),
                binaryen: value("--binaryen")?.map(PathBuf::from),
                debug: args.contains(&"--debug".into()),
                probes: args.contains(&"--probes".into()),
                jspi: args.contains(&"--jspi".into()),
            })?;
        }
        Some(other) => return Err(format!("unknown command {other}; use --help").into()),
    }
    Ok(())
}
