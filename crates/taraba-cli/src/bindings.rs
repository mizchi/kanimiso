//! Application-specific Core API. The runtime itself stays byte-identical across applications.
use crate::abi::{Abi, Bindings};
use crate::helpers::{self, Features};
use std::error::Error;

fn json(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}
fn ts_type(ty: Abi) -> &'static str {
    match ty {
        Abi::I32 | Abi::U32 | Abi::F64 => "number",
        Abi::Borrow | Abi::Own => "unknown",
    }
}
fn arguments(args: &[Abi]) -> String {
    args.iter()
        .enumerate()
        .map(|(i, t)| format!("a{i}: {}", ts_type(*t)))
        .collect::<Vec<_>>()
        .join(", ")
}

pub(crate) fn generate(
    abi: &Bindings,
    jspi: bool,
    helpers: Features,
) -> Result<(String, String), Box<dyn Error>> {
    // `then` would make the host a thenable and break Promise resolution.
    // Keep these names stable across profiles so a profile change cannot change the public API.
    for name in abi.exports.keys() {
        if matches!(
            name.as_str(),
            "imports" | "attach" | "stats" | "cancel" | "activeTasks" | "then"
        ) {
            return Err(format!("Core export {name:?} conflicts with the host API; rename it in WIT or use --component").into());
        }
    }
    Ok((javascript(abi, jspi, helpers), declarations(abi, jspi)))
}

fn javascript(abi: &Bindings, jspi: bool, helpers: Features) -> String {
    let exports = if jspi {
        format!(
            ", {}",
            serde_json::to_string(&abi.exports.keys().collect::<Vec<_>>()).unwrap()
        )
    } else {
        String::new()
    };
    let mut js = String::from("import { createHost as runtime } from './runtime.mjs';\n");
    if helpers.regexp {
        js.push_str("import { regexpImports } from './helpers-regexp.mjs';\n");
    }
    if helpers.values {
        js.push_str("import { createValues } from './helpers-values.mjs';\n");
    }
    let providers = [
        (
            helpers.strings,
            helpers::STRINGS,
            "stringImports",
            "strings",
        ),
        (
            helpers.iterator,
            helpers::ITERATOR,
            "iteratorImports",
            "iterator",
        ),
        (
            helpers.segmenter,
            helpers::SEGMENTER,
            "segmenterImports",
            "segmenter",
        ),
        (
            helpers.encoding,
            helpers::ENCODING,
            "encodingImports",
            "encoding",
        ),
    ];
    for (_, _, factory, name) in providers.iter().filter(|(enabled, ..)| *enabled) {
        js.push_str(&format!(
            "import {{ {factory} }} from './helpers-{name}.mjs';\n"
        ));
    }
    js.push_str(&format!(
        "export function createHost(options) {{\nconst host = runtime(options{exports});\n"
    ));
    if helpers.any() {
        js.push_str("let memory;\n");
        if helpers.values {
            js.push_str("const values = createValues(() => memory);\n");
        }
        js.push_str("const imports = {...host.imports");
        if helpers.regexp {
            js.push_str(&format!(
                ", [{}]: regexpImports(() => memory{})",
                json(helpers::REGEXP),
                if helpers.regexp_strings {
                    ", values"
                } else {
                    ""
                }
            ));
        }
        if helpers.values {
            js.push_str(&format!(", [{}]: values.imports", json(helpers::VALUES)));
        }
        for (_, module, factory, _) in providers.iter().filter(|(enabled, ..)| *enabled) {
            js.push_str(&format!(", [{}]: {factory}(values)", json(module)));
        }
        js.push_str("};\nconst attach = exports => { host.attach(exports); memory = exports.memory; };\nreturn { imports, attach,\n");
    } else {
        js.push_str("return { imports: host.imports, attach: host.attach,\n");
    }
    for name in abi.exports.keys() {
        js.push_str(&format!(
            "[{}]: {}(...args) => host.call({}, ...args),\n",
            json(name),
            if jspi { "" } else { "async " },
            json(name)
        ));
    }
    js.push_str("stats: host.stats");
    if !jspi {
        js.push_str(", cancel: host.cancel, activeTasks: host.activeTasks");
    }
    js.push_str("};\n}\n");
    js
}

fn declarations(abi: &Bindings, jspi: bool) -> String {
    let mut types = String::from("export interface AppBindings {\n");
    for ((_, name), (args, result)) in &abi.imports {
        let ret = result.map(ts_type).unwrap_or("void");
        types.push_str(&format!(
            "{}: ({}) => {ret}{};\n",
            json(name),
            arguments(args),
            if jspi {
                format!(" | PromiseLike<{ret}>")
            } else {
                String::new()
            }
        ));
    }
    types.push_str("}\nexport interface AppExports {\n");
    for (name, (args, result)) in &abi.exports {
        types.push_str(&format!(
            "{}({}): Promise<{}>;\n",
            json(name),
            arguments(args),
            result.map(ts_type).unwrap_or("void")
        ));
    }
    let (runtime_host, host_options) = if jspi {
        ("JspiHost", "JspiHostOptions")
    } else {
        ("Host", "HostOptions")
    };
    types.push_str(&format!(
        r#"}}
import type {{ {runtime_host}, {host_options} }} from './runtime.mjs';
export interface AppHost extends AppExports {{
readonly imports: WebAssembly.Imports;
attach(exports: WebAssembly.Exports): void;
stats: {runtime_host}['stats'];
"#
    ));
    if !jspi {
        types.push_str("cancel: Host['cancel'];\nactiveTasks: Host['activeTasks'];\n");
    }
    let optional = if abi.imports.is_empty() { "?" } else { "" };
    types.push_str(&format!(r#"}}
export type AppHostOptions = Omit<{host_options}, 'bindings'> & {{ bindings{optional}: AppBindings }};
export function createHost(options{optional}: AppHostOptions): AppHost;
"#));
    types
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_host_collisions_including_thenable_exports() {
        for name in [
            "imports",
            "attach",
            "stats",
            "cancel",
            "activeTasks",
            "then",
        ] {
            let mut abi = Bindings::default();
            abi.exports.insert(name.into(), (vec![], None));
            for jspi in [false, true] {
                assert!(
                    generate(&abi, jspi, Features::default())
                        .unwrap_err()
                        .to_string()
                        .contains(name)
                );
            }
        }
    }
    #[test]
    fn core_has_one_factory_and_one_dispatch_entry() {
        let mut abi = Bindings::default();
        abi.exports
            .insert("run".into(), (vec![Abi::I32], Some(Abi::I32)));
        for jspi in [false, true] {
            let (js, types) = generate(&abi, jspi, Features::default()).unwrap();
            assert!(!js.contains("instantiate"));
            assert!(!types.contains("Instantiate"));
            assert!(js.contains("host.call("));
            assert!(!js.contains("host.promise("));
            assert!(js.contains(if jspi {
                "(...args) => host.call"
            } else {
                "async (...args) => host.call"
            }));
        }
    }
    #[test]
    fn import_free_hosts_need_no_options() {
        let (_, types) = generate(&Bindings::default(), true, Features::default()).unwrap();
        assert!(types.contains("createHost(options?: AppHostOptions)"));
    }
}
