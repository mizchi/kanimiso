use std::{fs, path::PathBuf};
use taraba_cli::insight;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub fn run(args: &[String]) -> Result<()> {
    if args == ["--help"] {
        println!(
            "taraba insight [pkg | file.wasm] [--top 20] [--filter <substring>] [--retained] [--paths <substring>] [--json]\nDefault: pkg/.taraba/insight.wasm when available, otherwise pkg/app.wasm. Read-only. Retained sizes cover the conservative function-reference graph, not predicted removal savings."
        );
        return Ok(());
    }
    let (mut input, mut top, mut filter, mut retained, mut paths, mut json) =
        (None, 20, None, false, false, false);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json = true,
            "--retained" => retained = true,
            "--top" | "--filter" | "--paths" => {
                let flag = &args[i];
                i += 1;
                let value = args
                    .get(i)
                    .filter(|s| !s.starts_with("--"))
                    .ok_or_else(|| format!("missing value for {flag}"))?;
                if flag == "--top" {
                    top = value
                        .parse::<usize>()
                        .ok()
                        .filter(|n| *n > 0)
                        .ok_or("--top must be a positive integer")?;
                } else {
                    filter = Some(value.as_str());
                    paths |= flag == "--paths";
                }
            }
            arg if !arg.starts_with("--") && input.is_none() => input = Some(PathBuf::from(arg)),
            arg => return Err(format!("unknown insight argument: {arg}").into()),
        }
        i += 1;
    }
    let input = input.unwrap_or_else(|| PathBuf::from("pkg"));
    let (file, deployment) = if input.is_dir() {
        let deployed = input.join("app.wasm");
        let named = input.join(".taraba/insight.wasm");
        if named.exists() {
            let analysis = fs::read(&named)?;
            let deployment = fs::read(&deployed)?;
            if insight::strip_names(&analysis)? != deployment {
                return Err("insight data is stale: rebuild with taraba build --insight".into());
            }
            (named, Some(deployment.len()))
        } else {
            (deployed, None)
        }
    } else {
        (input, None)
    };
    let report = insight::analyze(&fs::read(&file)?)?;
    let mut view = report.json(top, filter, retained, paths);
    view["input"] = file.to_string_lossy().to_string().into();
    if let Some(bytes) = deployment {
        view["deployment_bytes"] = bytes.into();
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&view)?);
        return Ok(());
    }
    println!(
        "{}: {} B ({} B name metadata)",
        file.display(),
        report.total_bytes,
        view["name_bytes"]
    );
    if let Some(bytes) = deployment {
        println!("Deployed app.wasm: {bytes} B; identical code, names excluded");
    }
    println!("\nSections (headers included):");
    for s in &report.sections {
        println!("{:>9}  {}", s.bytes, s.name);
    }
    println!("\n  Shallow  Retained  Function");
    for f in view["functions"].as_array().unwrap() {
        let retained = f["retained_bytes"]
            .as_u64()
            .map_or_else(|| "-".to_owned(), |n| n.to_string());
        println!(
            "{:>9} {:>9}  {}",
            f["shallow_bytes"].as_u64().unwrap(),
            retained,
            f["name"].as_str().unwrap()
        );
        if paths {
            println!(
                "                     {}",
                f["path"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(" → ")
            );
        }
    }
    println!("\nFunction bytes by heuristic group: {}", view["groups"]);
    for note in view["notes"].as_array().unwrap() {
        println!("{}", note.as_str().unwrap());
    }
    Ok(())
}
