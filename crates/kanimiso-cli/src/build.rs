use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
pub struct BuildOptions {
    pub input: PathBuf,
    pub wit: PathBuf,
    pub world: Option<String>,
    pub output: PathBuf,
    pub binaryen: Option<PathBuf>,
    pub debug: bool,
    pub probes: bool,
}
const FEATURES: &[&str] = &[
    "mutable-globals",
    "sign-ext",
    "nontrapping-float-to-int",
    "simd",
    "bulk-memory",
    "reference-types",
    "multivalue",
    "gc",
    "tail-call",
    "exception-handling",
    "extended-const",
    "multimemory",
];
fn run(bin: &Path, args: &[String]) -> Result<()> {
    let output = Command::new(bin).args(args).output()?;
    if !output.status.success() {
        return Err(format!(
            "{} failed: {}",
            bin.display(),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}
fn text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
pub fn build(o: &BuildOptions) -> Result<()> {
    let binaryen = o
        .binaryen
        .clone()
        .or_else(|| std::env::var_os("KANIMISO_BINARYEN").map(PathBuf::from));
    let tool = |name: &str| {
        binaryen
            .as_ref()
            .map(|p| p.join(name))
            .unwrap_or_else(|| PathBuf::from(name))
    };
    for name in ["wasm-opt", "wasm-as", "wasm-merge", "wasm-metadce"] {
        let v = Command::new(tool(name))
            .arg("--version")
            .output()
            .map_err(|e| format!("{name}: {e}; install Binaryen 133 or set KANIMISO_BINARYEN"))?;
        if !v.status.success()
            || !String::from_utf8_lossy(&v.stdout)
                .split_whitespace()
                .any(|s| s == "133")
        {
            return Err(format!("{name} must be Binaryen 133").into());
        }
    }
    let abi = crate::wit::parse(&o.wit, o.world.as_deref())?;
    let raw = fs::read(&o.input)?;
    let core = crate::abi::lower_with_abi(&raw, &abi)?;
    let m = walrus::Module::from_buffer(&core)?;
    let exports: Vec<_> = m.exports.iter().map(|e| e.name.clone()).collect();
    let temp = tempfile::tempdir()?;
    let path = |name: &str| temp.path().join(name);
    fs::write(path("core.wasm"), &core)?;
    fs::write(
        path("slots.wat"),
        if o.probes {
            include_bytes!("../assets/intrusive-probes.wat").as_slice()
        } else {
            include_bytes!("../assets/intrusive.wat").as_slice()
        },
    )?;
    run(
        &tool("wasm-as"),
        &[
            text(&path("slots.wat")),
            "-o".into(),
            text(&path("slots.wasm")),
        ],
    )?;
    let features: Vec<String> = FEATURES.iter().map(|f| format!("--enable-{f}")).collect();
    let mut merge = vec![
        text(&path("core.wasm")),
        "kanimiso:core".into(),
        text(&path("slots.wasm")),
        "pool".into(),
    ];
    merge.extend(features.clone());
    merge.extend(["-o".into(), text(&path("merged.wasm"))]);
    run(&tool("wasm-merge"), &merge)?;
    let graph: Vec<_> = exports
        .iter()
        .map(|name| serde_json::json!({"name":format!("host:{name}"),"export":name,"root":true}))
        .chain(
            ["allocate", "free", "used"]
                .map(|name| serde_json::json!({"name":format!("internal:{name}"),"export":name})),
        )
        .collect();
    fs::write(path("graph.json"), serde_json::to_vec(&graph)?)?;
    let mut dce = vec![text(&path("merged.wasm"))];
    dce.extend(features.clone());
    dce.extend([
        "--graph-file".into(),
        text(&path("graph.json")),
        "-o".into(),
        text(&path("linked.wasm")),
    ]);
    run(&tool("wasm-metadce"), &dce)?;
    let mut opt = vec![
        text(&path("linked.wasm")),
        "-Oz".into(),
        "--strip-debug".into(),
        "--strip-producers".into(),
        "--strip-target-features".into(),
    ];
    opt.extend(features);
    opt.extend([
        "--flatten".into(),
        "--rereloop".into(),
        "-Oz".into(),
        "--converge".into(),
        "-o".into(),
        text(&path("optimized.wasm")),
    ]);
    run(&tool("wasm-opt"), &opt)?;
    let optimized = fs::read(path("optimized.wasm"))?;
    let names = serde_json::from_str(include_str!("../assets/private-imports.json"))?;
    let bytes = crate::imports::rename(&optimized, &names)?;
    let finished = walrus::Module::from_buffer(&bytes)?;
    let actual: std::collections::BTreeSet<_> =
        finished.exports.iter().map(|e| e.name.clone()).collect();
    if actual != exports.iter().cloned().collect() {
        return Err("link changed exported API".into());
    }
    if finished
        .imports
        .iter()
        .any(|i| i.module != "jsrt" && i.module != "app")
    {
        return Err("unexpected import after Core linking".into());
    }
    fs::create_dir_all(&o.output)?;
    let dest = o.output.join("app.wasm");
    if dest.exists() && fs::canonicalize(&dest)? == fs::canonicalize(&o.input)? {
        return Err("output must not overwrite input".into());
    }
    let js = if o.debug {
        include_bytes!("../assets/kanimiso-debug.mjs").as_slice()
    } else {
        include_bytes!("../assets/kanimiso.mjs").as_slice()
    };
    fs::write(dest, &bytes)?;
    fs::write(o.output.join("kanimiso.mjs"), js)?;
    fs::write(
        o.output.join("kanimiso.d.mts"),
        include_bytes!("../assets/kanimiso.d.mts"),
    )?;
    fs::write(
        o.output.join("error-codes.json"),
        include_bytes!("../assets/error-codes.json"),
    )?;
    let info = serde_json::json!({"builder":env!("CARGO_PKG_VERSION"),"profile":"wit-core-externref","binaryen":133,"wasm_bytes":bytes.len(),"js_bytes":js.len(),"debug":o.debug,"assets":serde_json::from_str::<serde_json::Value>(include_str!("../assets/provenance.json"))?});
    fs::write(
        o.output.join("build.json"),
        serde_json::to_vec_pretty(&info)?,
    )?;
    println!(
        "{}: {} B Wasm + {} B JS",
        o.output.display(),
        bytes.len(),
        js.len()
    );
    Ok(())
}
