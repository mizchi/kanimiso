use crate::ExecutionProfile;
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
#[derive(Clone)]
pub struct BuildOptions {
    pub input: PathBuf,
    pub wit: PathBuf,
    pub world: Option<String>,
    pub output: PathBuf,
    pub binaryen: Option<PathBuf>,
    pub debug: bool,
    pub probes: bool,
    pub abort_signal: bool,
    pub task_slots: Option<u32>,
    pub insight: bool,
    pub profile: ExecutionProfile,
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
pub(crate) fn optimization_flags() -> Vec<String> {
    let mut flags: Vec<String> = [
        "-Oz",
        "--strip-debug",
        "--strip-producers",
        "--strip-target-features",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    flags.extend(FEATURES.iter().map(|f| format!("--enable-{f}")));
    flags.extend(
        ["--flatten", "--rereloop", "-Oz", "--converge"]
            .into_iter()
            .map(Into::into),
    );
    flags
}
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
fn task_slots(bytes: &[u8], requested: Option<u32>) -> Result<u32> {
    let mut found = None;
    for p in wasmparser::Parser::new(0).parse_all(bytes) {
        if let wasmparser::Payload::CustomSection(section) = p? {
            if matches!(section.name(), "taraba:task-slots" | "taraba:runtime-abi") {
                if found.is_some() {
                    return Err("duplicate task pool configuration".into());
                }
                let data: [u8; 4] = section
                    .data()
                    .try_into()
                    .map_err(|_| "invalid task pool configuration")?;
                let word = u32::from_le_bytes(data);
                let slots = if section.name() == "taraba:runtime-abi" {
                    (word & 0xffff) + 1
                } else {
                    word
                };
                if !(1..=65536).contains(&slots) {
                    return Err("task pool capacity must be 1..=65536".into());
                }
                found = Some(slots);
            }
        }
    }
    if let Some(requested) = requested {
        if found != Some(requested) {
            return Err("--task-slots differs from compiled Rust storage; rebuild with a matching taraba runtime and capacity".into());
        }
    }
    Ok(found.unwrap_or(1024))
}
pub fn build(o: &BuildOptions) -> Result<()> {
    let jspi = o.profile == ExecutionProfile::Jspi;
    if jspi && o.abort_signal {
        return Err("--abort-signal requires the Core Future runtime".into());
    }
    let raw = fs::read(&o.input)?;
    let runtime_abi = crate::runtime_abi::validate(&raw)?;
    let binaryen = o
        .binaryen
        .clone()
        .or_else(|| std::env::var_os("TARABA_BINARYEN").map(PathBuf::from));
    let tool = |name: &str| {
        binaryen
            .as_ref()
            .map(|p| p.join(name))
            .unwrap_or_else(|| PathBuf::from(name))
    };
    let tools: &[&str] = if jspi {
        &["wasm-opt"]
    } else {
        &["wasm-opt", "wasm-as", "wasm-merge", "wasm-metadce"]
    };
    for name in tools {
        let v = Command::new(tool(name))
            .arg("--version")
            .output()
            .map_err(|e| format!("{name}: {e}; install Binaryen 133 or set TARABA_BINARYEN"))?;
        if !v.status.success()
            || !String::from_utf8_lossy(&v.stdout)
                .split_whitespace()
                .any(|s| s == "133")
        {
            return Err(format!("{name} must be Binaryen 133").into());
        }
    }
    let mut abi = crate::wit::parse(&o.wit, o.world.as_deref())?;
    if jspi {
        if o.probes || abi.uses_resource_handles() {
            return Err("JSPI profile supports only scalar WIT functions (s32/u32/f64), without resources or --probes".into());
        }
    }
    let capacity = task_slots(&raw, o.task_slots)?;
    let core = crate::abi::lower_with_abi(&raw, &abi)?;
    let m = walrus::Module::from_buffer(&core)?;
    let needs_pool = m.imports.iter().any(|i| i.module == "pool");
    if o.task_slots.is_some() && !needs_pool {
        return Err("--task-slots requires the Core Future task pool".into());
    }
    let exports: Vec<_> = m.exports.iter().map(|e| e.name.clone()).collect();
    let temp = tempfile::tempdir()?;
    let path = |name: &str| temp.path().join(name);
    fs::write(path("core.wasm"), &core)?;
    let features: Vec<String> = FEATURES.iter().map(|f| format!("--enable-{f}")).collect();
    if jspi || !needs_pool {
        // JSPI owns suspension stacks. A synchronous Future-profile library
        // also needs no pool: do not link unused task allocation functions.
        fs::write(path("linked.wasm"), &core)?;
    } else {
        fs::write(
            path("slots.wat"),
            (if o.probes {
                include_str!("../assets/intrusive-probes.wat")
            } else {
                include_str!("../assets/intrusive.wat")
            })
            .replace("(i32.const 1024)", &format!("(i32.const {capacity})")),
        )?;
        let mut assemble = vec![
            text(&path("slots.wat")),
            "-o".into(),
            text(&path("slots.wasm")),
        ];
        if o.insight {
            assemble.push("--debuginfo".into());
        }
        run(&tool("wasm-as"), &assemble)?;
        let mut merge = vec![
            text(&path("core.wasm")),
            "taraba:core".into(),
            text(&path("slots.wasm")),
            "pool".into(),
        ];
        merge.extend(features.clone());
        if o.insight {
            merge.push("--debuginfo".into());
        }
        merge.extend(["-o".into(), text(&path("merged.wasm"))]);
        run(&tool("wasm-merge"), &merge)?;
        let graph: Vec<_> = exports
            .iter()
            .map(
                |name| serde_json::json!({"name":format!("host:{name}"),"export":name,"root":true}),
            )
            .chain(
                ["allocate", "free", "used"].map(
                    |name| serde_json::json!({"name":format!("internal:{name}"),"export":name}),
                ),
            )
            .collect();
        fs::write(path("graph.json"), serde_json::to_vec(&graph)?)?;
        let mut dce = vec![text(&path("merged.wasm"))];
        dce.extend(features.clone());
        if o.insight {
            dce.push("--debuginfo".into());
        }
        dce.extend([
            "--graph-file".into(),
            text(&path("graph.json")),
            "-o".into(),
            text(&path("linked.wasm")),
        ]);
        run(&tool("wasm-metadce"), &dce)?;
    }
    let mut opt = vec![text(&path("linked.wasm"))];
    let mut flags = optimization_flags();
    if o.insight {
        for flag in &mut flags {
            if flag == "--strip-debug" {
                *flag = "--strip-dwarf".into();
            }
        }
        flags.push("--debuginfo".into());
    }
    opt.extend(flags);
    opt.extend(["-o".into(), text(&path("optimized.wasm"))]);
    run(&tool("wasm-opt"), &opt)?;
    let optimized = fs::read(path("optimized.wasm"))?;
    let names = serde_json::from_str(include_str!("../assets/private-imports.json"))?;
    let named = crate::imports::rename(&optimized, &names)?;
    let mut bytes = if o.insight {
        crate::insight::strip_names(&named)?
    } else {
        named.clone()
    };
    let analysis = if o.insight {
        Some(crate::insight::analyze(&named)?.json(usize::MAX, None, false, false))
    } else {
        None
    };
    let finished = walrus::Module::from_buffer(&bytes)?;
    let actual: std::collections::BTreeSet<_> =
        finished.exports.iter().map(|e| e.name.clone()).collect();
    if actual != exports.iter().cloned().collect() {
        return Err("link changed exported API".into());
    }
    if finished.imports.iter().any(|i| {
        !matches!(i.module.as_str(), "jsrt" | "app" | "taraba:panic")
            && !crate::helpers::known_module(&i.module)
    }) {
        return Err("unexpected import after Core linking".into());
    }
    if jspi
        && finished.imports.iter().any(|i| {
            !matches!(i.module.as_str(), "app" | "taraba:panic")
                && !crate::helpers::known_module(&i.module)
        })
    {
        return Err(
            "JSPI profile requires a synchronous scalar guest without taraba task/runtime imports"
                .into(),
        );
    }
    fs::create_dir_all(&o.output)?;
    let helpers = crate::helpers::Features::detect(&finished);
    let live_codecs: std::collections::BTreeSet<_> = finished
        .imports
        .iter()
        .filter(|i| i.module == "app")
        .map(|i| i.name.clone())
        .collect();
    let removed: Vec<_> = abi
        .codecs
        .keys()
        .filter(|name| !live_codecs.contains(*name))
        .cloned()
        .collect();
    for name in removed {
        abi.imports.retain(|(_, n), _| n != &name);
        abi.codecs.remove(&name);
    }
    abi.live_imports = Some(live_codecs);
    crate::bindings::compact_imports(&mut abi);
    bytes = crate::imports::rename_app(&bytes, &abi.wire_names)?;
    bytes = crate::imports::rename_exports(&bytes, &abi.wire_names)?;
    let (bindings_js, bindings_types) =
        crate::bindings::generate_with_abort(&abi, jspi, helpers.clone(), o.abort_signal)?;
    let dest = o.output.join("app.wasm");
    if dest.exists() && fs::canonicalize(&dest)? == fs::canonicalize(&o.input)? {
        return Err("output must not overwrite input".into());
    }
    let helpers_js = helpers.write(&o.output, o.debug)?;
    let js = if jspi {
        if o.debug {
            include_bytes!("../assets/taraba-jspi-debug.mjs").as_slice()
        } else {
            include_bytes!("../assets/taraba-jspi.mjs").as_slice()
        }
    } else if o.abort_signal {
        if o.debug {
            include_bytes!("../assets/taraba-abort-debug.mjs").as_slice()
        } else {
            include_bytes!("../assets/taraba-abort.mjs").as_slice()
        }
    } else if o.debug {
        include_bytes!("../assets/taraba-debug.mjs").as_slice()
    } else {
        include_bytes!("../assets/taraba.mjs").as_slice()
    };
    fs::write(dest, &bytes)?;
    fs::write(o.output.join("runtime.mjs"), js)?;
    fs::write(o.output.join("index.js"), &bindings_js)?;
    fs::write(o.output.join("index.d.ts"), bindings_types)?;
    fs::write(
        o.output.join("runtime.d.mts"),
        if jspi {
            include_bytes!("../assets/taraba-jspi.d.mts").as_slice()
        } else {
            include_bytes!("../assets/taraba.d.mts").as_slice()
        },
    )?;
    let mut info = serde_json::json!({"builder":env!("CARGO_PKG_VERSION"),"profile":if jspi {"wit-core-jspi"}else{"wit-core-externref"},"engine_baseline":"Safari 27+ / JSPI-capable V8","binaryen":133,"wasm_bytes":bytes.len(),"js_bytes":js.len()+bindings_js.len()+helpers_js,"runtime_js_bytes":js.len(),"bindings_js_bytes":bindings_js.len(),"debug":o.debug,"abort_signal":o.abort_signal,"assets":serde_json::from_str::<serde_json::Value>(include_str!("../assets/provenance.json"))?});
    if let Some(revision) = runtime_abi {
        info["runtime_abi"] = revision.into();
    }
    if needs_pool {
        info["task_slots"] = capacity.into();
        info["task_pool_bytes"] = (capacity * 128).into();
    }
    if helpers.any() {
        info["helpers_js_bytes"] = helpers_js.into();
    }
    if let Some(mut report) = analysis {
        fs::create_dir_all(o.output.join(".taraba"))?;
        report["deployment_bytes"] = bytes.len().into();
        fs::write(o.output.join(".taraba/insight.wasm"), &named)?;
        fs::write(
            o.output.join(".taraba/insight.json"),
            serde_json::to_vec_pretty(&report)?,
        )?;
        info["insight"] = serde_json::json!({"wasm":".taraba/insight.wasm","report":".taraba/insight.json","local_only":true});
    }
    fs::write(
        o.output.join("build.json"),
        serde_json::to_vec_pretty(&info)?,
    )?;
    println!(
        "{}: {} B Wasm + {} B JS",
        o.output.display(),
        bytes.len(),
        js.len() + bindings_js.len() + helpers_js
    );
    Ok(())
}

#[cfg(test)]
mod pool_tests {
    #[test]
    fn compiled_pool_capacity_is_validated_and_cannot_be_overridden_for_raw_wasm() {
        let bytes = |slots: u32| {
            let mut m = walrus::Module::default();
            m.customs.add(walrus::RawCustomSection {
                name: "taraba:task-slots".into(),
                data: slots.to_le_bytes().to_vec(),
            });
            m.emit_wasm()
        };
        assert_eq!(super::task_slots(&bytes(16), Some(16)).unwrap(), 16);
        assert!(super::task_slots(&bytes(16), Some(32)).is_err());
        assert!(super::task_slots(&bytes(0), None).is_err());
        assert!(super::task_slots(&bytes(65537), None).is_err());
        assert_eq!(
            super::task_slots(&walrus::Module::default().emit_wasm(), None).unwrap(),
            1024
        );
    }
}
