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
        Abi::Borrow | Abi::Own | Abi::FutureValue => "unknown",
        Abi::FutureI32 => "number",
        Abi::FutureVoid => "void",
    }
}
fn arguments(args: &[Abi]) -> String {
    args.iter()
        .enumerate()
        .map(|(i, t)| format!("a{i}: {}", ts_type(*t)))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
pub(crate) fn generate(
    abi: &Bindings,
    jspi: bool,
    helpers: Features,
) -> Result<(String, String), Box<dyn Error>> {
    generate_with_abort(abi, jspi, helpers, false)
}
pub(crate) fn generate_with_abort(
    abi: &Bindings,
    jspi: bool,
    helpers: Features,
    abort: bool,
) -> Result<(String, String), Box<dyn Error>> {
    if abort && jspi {
        return Err("AbortSignal requires the Core Future runtime".into());
    }
    // `then` would make the host a thenable and break Promise resolution.
    // Keep these names stable across profiles so a profile change cannot change the public API.
    for name in abi.exports.keys().map(|n| {
        abi.interface_members
            .get(n)
            .map(|m| &m.namespace)
            .unwrap_or(n)
    }) {
        if matches!(
            name.as_str(),
            "imports" | "attach" | "stats" | "cancel" | "activeTasks" | "dispose" | "then"
        ) {
            return Err(format!("Core export {name:?} conflicts with the host API; rename it in WIT or use --component").into());
        }
    }
    Ok((
        javascript(abi, jspi, helpers, abort),
        declarations(abi, jspi, abort),
    ))
}

// Assign only after optimization so unused declarations cannot change deployed names.
// Equal codec bodies share a JS callback even when their Wasm signatures differ.
pub(crate) fn compact_imports(abi: &mut Bindings) {
    use std::collections::{BTreeMap, BTreeSet};
    let private = |n: &String| abi.codecs.contains_key(n) || abi.interface_members.contains_key(n);
    let mut used: BTreeSet<String> = abi
        .imports
        .keys()
        .filter(|(_, n)| {
            !private(n)
                && abi
                    .live_imports
                    .as_ref()
                    .is_none_or(|live| live.contains(n))
        })
        .map(|(_, n)| n.clone())
        .collect();
    used.extend(abi.exports.keys().cloned());
    let mut bodies = BTreeMap::<String, String>::new();
    let mut next = 0usize;
    let mut names = BTreeMap::new();
    for name in abi
        .imports
        .keys()
        .filter(|(_, n)| {
            private(n)
                && abi
                    .live_imports
                    .as_ref()
                    .is_none_or(|live| live.contains(n))
        })
        .map(|(_, n)| n)
        .chain(abi.exports.keys().filter(|n| {
            abi.interface_members.contains_key(*n)
                || abi.guest_resources.values().any(|g| &g.drop_export == *n)
        }))
    {
        if names.contains_key(name) {
            continue;
        }
        let body = abi.codecs.get(name);
        if let Some(previous) = body.and_then(|b| bodies.get(b)) {
            names.insert(name.clone(), previous.clone());
            continue;
        }
        let short = loop {
            let mut number = next;
            next += 1;
            let mut short = String::new();
            loop {
                let digit = number % 52;
                short.push(
                    (if digit < 26 {
                        b'a' + digit as u8
                    } else {
                        b'A' + (digit - 26) as u8
                    }) as char,
                );
                number /= 52;
                if number == 0 {
                    break;
                }
            }
            if used.insert(short.clone()) {
                break short;
            }
        };
        if let Some(body) = body {
            bodies.insert(body.clone(), short.clone());
        }
        names.insert(name.clone(), short);
    }
    abi.wire_names = names;
}
fn wire_name<'a>(abi: &'a Bindings, name: &'a str) -> &'a str {
    abi.wire_names.get(name).map(String::as_str).unwrap_or(name)
}
fn javascript(abi: &Bindings, jspi: bool, helpers: Features, abort: bool) -> String {
    let exports = if jspi {
        format!(
            ", {}",
            serde_json::to_string(
                &abi.exports
                    .keys()
                    .map(|n| wire_name(abi, n))
                    .collect::<Vec<_>>()
            )
            .unwrap()
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
    let codecs = !abi.codecs.is_empty();
    let codec_memory = abi.codecs.values().any(|s| s.contains("memory."));
    if abi.codecs.values().any(|s| s.contains("encoder.")) {
        js.push_str("const encoder = new TextEncoder();\n");
    }
    if abi.codecs.values().any(|s| s.contains("decoder.")) {
        js.push_str("const decoder = new TextDecoder(\"utf-8\", {ignoreBOM: true});\n");
    }
    let resources = abi.codecs.values().any(|s| s.contains("resources."));
    let guests = !abi.guest_resources.is_empty();
    if guests {
        js.push_str(&include_str!("templates/guest-resources.mjs").replacen(
            "export function",
            "function",
            1,
        ));
    }

    if resources {
        js.push_str(&include_str!("templates/resources.mjs").replacen(
            "export function",
            "function",
            1,
        ));
    }
    js.push_str("export function createHost(options) {\n");
    if guests {
        let drops = abi
            .guest_resources
            .iter()
            .map(|(name, g)| format!("{}:{}", json(name), json(wire_name(abi, &g.drop_export))))
            .collect::<Vec<_>>()
            .join(",");
        js.push_str(&format!("const dropNames={{{drops}}}; const guestResources=createGuestResources((type,key)=>{{try{{dispatch(dropNames[type]{} ,key)}}catch(error){{host.dispose();throw error}}}});\n", if abort { ",undefined" } else { "" }));
    }

    if resources {
        js.push_str("const resources=createResources();\n");
    }
    let live_import = |name: &String| {
        abi.live_imports
            .as_ref()
            .is_none_or(|live| live.contains(name))
    };
    let aliases = abi.imports.keys().any(|(_, n)| {
        (abi.interface_members.contains_key(n) || abi.host_marshalling.contains_key(n))
            && live_import(n)
    });
    if aliases {
        js.push_str("let bindings=options?.bindings; options={...options, bindings:{");
        let mut entries = Vec::new();
        for (_, name) in abi
            .imports
            .keys()
            .filter(|(_, n)| !abi.codecs.contains_key(n) && live_import(n))
        {
            let source = if let Some(m) = abi.interface_members.get(name) {
                format!("bindings[{}][{}]", json(&m.namespace), json(&m.method))
            } else {
                format!("bindings[{}]", json(name))
            };
            let value = if let Some((args, result, asynchronous)) = abi.host_marshalling.get(name) {
                let mut parameters = (0..args.len()).map(|i| format!("a{i}")).collect::<Vec<_>>();
                let mut values = args.clone();
                if abort {
                    parameters.push("context".into());
                    values.push("context".into());
                }
                let call = if let Some(m) = abi.interface_members.get(name).filter(|m| m.receiver) {
                    format!(
                        "{}[{}]({})",
                        values[0],
                        json(&m.method),
                        values[1..].join(",")
                    )
                } else {
                    format!("{source}({})", values.join(","))
                };
                let body = if let Some(result) = result {
                    if *asynchronous {
                        format!("Promise.resolve({call}).then(value=>{result})")
                    } else {
                        format!("(value=>{result})({call})")
                    }
                } else {
                    call
                };
                format!("({})=>{body}", parameters.join(","))
            } else if abi.interface_members.contains_key(name) {
                format!("(...args)=>{source}(...args)")
            } else {
                source
            };
            entries.push(format!("{}:{value}", json(wire_name(abi, name))));
        }
        js.push_str(&entries.join(","));
        js.push_str("}};\n");
    }
    if codecs {
        if codec_memory {
            js.push_str("let memory;\n");
        }
        js.push_str("options = {...options, bindings: {...options?.bindings");
        let mut emitted = std::collections::BTreeSet::new();
        for (name, body) in &abi.codecs {
            let name = wire_name(abi, name);
            if emitted.insert(name) {
                js.push_str(&format!(", {}: {}", json(name), body));
            }
        }
        js.push_str("}};\n");
    }
    js.push_str(&format!(
        "const {{ {dispatch}, ...host }} = runtime(options{exports});\n",
        dispatch = if resources || guests || codec_memory || helpers.any() || aliases {
            "call: dispatch"
        } else {
            "call"
        }
    ));
    let cleanup = resources || guests || codec_memory || helpers.any() || aliases;
    if cleanup {
        let mut close = String::new();
        if guests {
            close.push_str("try{guestResources.close(true)}finally{");
        }
        if resources {
            close.push_str("try{resources.close()}finally{");
        }
        if helpers.values {
            close.push_str("values[Symbol.dispose]();");
        }
        if helpers.regexp {
            close.push_str(&format!(
                "host.imports[{}][Symbol.dispose]();",
                json(helpers::REGEXP)
            ));
        }
        if codec_memory || helpers.any() {
            close.push_str("memory=undefined;");
        }
        if aliases {
            close.push_str("bindings=undefined;");
        }
        if resources {
            close.push('}');
        }
        if guests {
            close.push('}');
        }
        js.push_str(&format!(
            "const dispose=host.dispose; const close=()=>{{if(host.stats().dead){{{close}}}}};\n"
        ));
        if guests {
            js.push_str("const quietly=()=>{try{close()}catch{}}; host.dispose=()=>{let first,failed=false;try{if(!host.stats().dead)guestResources.close()}catch(error){first=error;failed=true}try{dispose()}catch(error){if(!failed){first=error;failed=true}}if(host.stats().dead)quietly();else queueMicrotask(quietly);if(failed)throw first};const call=async(...args)=>{try{return await dispatch(...args)}catch(error){quietly();throw error}};\n");
        } else if resources {
            js.push_str("const quietly=()=>{try{close()}catch{}}; host.dispose=()=>{try{dispose()}catch(error){quietly();throw error}if(host.stats().dead)close();else queueMicrotask(quietly)}; const call=async(...args)=>{try{return await dispatch(...args)}catch(error){quietly();throw error}};\n");
        } else {
            // Only generated Map.clear and reference assignments: cleanup cannot throw.
            js.push_str("host.dispose=()=>{try{dispose()}finally{if(host.stats().dead)close();else queueMicrotask(close)}}; const call=async(...args)=>{try{return await dispatch(...args)}catch(error){close();throw error}};\n");
        }
    }
    if codec_memory {
        js.push_str("const connect = host.attach; host.attach = exports => { connect(exports); memory = exports.memory; };\n");
    }

    if helpers.any() {
        if !codec_memory {
            js.push_str("let memory;\n");
        }
        if helpers.values {
            js.push_str("const values = createValues(() => memory);\n");
        }
        js.push_str("host.imports = {...host.imports");
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
        js.push_str("};\nconst attach = host.attach;\nhost.attach = exports => { attach(exports); memory = exports.memory; };\n");
    }
    for namespace in abi
        .exports
        .keys()
        .filter_map(|n| abi.interface_members.get(n).map(|m| &m.namespace))
        .collect::<std::collections::BTreeSet<_>>()
    {
        js.push_str(&format!("host[{}]={{}};\n", json(namespace)));
    }
    for name in abi.exports.keys() {
        if abi
            .guest_resources
            .values()
            .any(|g| &g.drop_export == name || g.methods.values().any(|n| n == name))
        {
            continue;
        }
        let target = if let Some(m) = abi.interface_members.get(name) {
            format!("host[{}][{}]", json(&m.namespace), json(&m.method))
        } else {
            format!("host[{}]", json(wire_name(abi, name)))
        };
        if abort {
            let count = abi
                .public_exports
                .get(name)
                .map(|s| s.args.len())
                .unwrap_or(abi.exports[name].0.len());
            let args = (0..count).map(|i| format!("a{i}")).collect::<Vec<_>>();
            let mut parameters = args.clone();
            parameters.push("options".into());
            let tail = if args.is_empty() {
                String::new()
            } else {
                format!(", {}", args.join(", "))
            };
            js.push_str(&format!(
                "{} = async ({}) => call({}, options?.signal{});\n",
                target,
                parameters.join(", "),
                json(wire_name(abi, name)),
                tail
            ));
        } else {
            js.push_str(&format!(
                "{} = {}(...args) => call({}, ...args);\n",
                target,
                if jspi { "" } else { "async " },
                json(wire_name(abi, name))
            ));
        }
    }
    for (name, g) in &abi.guest_resources {
        let mut methods = Vec::new();
        for (method, wire) in &g.methods {
            let signature = &abi.public_exports[wire];
            let args = (1..signature.args.len())
                .map(|i| format!("a{i}"))
                .collect::<Vec<_>>();
            let mut params = args.clone();
            if abort {
                params.push("options".into());
            }
            let tail = if args.is_empty() {
                String::new()
            } else {
                format!(",{}", args.join(","))
            };
            methods.push(format!(
                "{}:async({})=>call({}{} ,self{tail})",
                json(method),
                params.join(","),
                json(wire_name(abi, wire)),
                if abort { ",options?.signal" } else { "" }
            ));
        }
        js.push_str(&format!(
            "guestResources.define({},self=>({{{}}}));\n",
            json(name),
            methods.join(",")
        ));
    }
    js.push_str("return host;\n}\n");
    js
}

fn input_type(ty: &str) -> String {
    if matches!(ty, "number" | "bigint" | "boolean" | "string" | "void") {
        ty.into()
    } else {
        format!("WitInput<{ty}>")
    }
}

fn public_arguments(
    signature: &crate::abi::PublicSignature,
    input: bool,
    required: bool,
    resources: bool,
) -> String {
    signature
        .args
        .iter()
        .enumerate()
        .map(|(i, ty)| {
            let optional = if !required && signature.args[i..].iter().all(|p| p.optional) {
                "?"
            } else {
                ""
            };
            format!(
                "a{i}{optional}: {}",
                if input {
                    input_type(&ty.ty)
                } else if resources {
                    format!("HostValue<{}, Resources>", ty.ty)
                } else {
                    ty.ty.clone()
                }
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn append_parameter(args: &str, parameter: &str) -> String {
    if args.is_empty() {
        parameter.into()
    } else {
        format!("{args}, {parameter}")
    }
}

fn declarations(abi: &Bindings, jspi: bool, abort: bool) -> String {
    let mut types = abi.type_declarations.clone();
    for (name, methods) in &abi.resource_methods {
        let mut body = String::new();
        for (method, signature) in methods {
            let mut args = public_arguments(signature, false, abort, true);
            if abort {
                args = append_parameter(&args, "context: HostContext");
            }
            let result = input_type(&format!("HostValue<{}, Resources>", signature.result));
            body.push_str(&format!(
                "{}({args}): {result}{};",
                json(method),
                if signature.asynchronous {
                    format!("|PromiseLike<{result}>")
                } else {
                    String::new()
                }
            ));
        }
        // ResourceTypes cannot refer to its own Resources mapping; recursive
        // host resources use the default mapping, which remains structurally typed.
        let body = body.replace(", Resources>", ", ResourceTypes>");
        types = types.replace(
            &format!("{}:Disposable;", json(name)),
            &format!("{}:Disposable & {{{body}}};", json(name)),
        );
    }
    for (name, g) in &abi.guest_resources {
        let mut body = String::new();
        for (method, wire) in &g.methods {
            let mut signature = abi.public_exports[wire].clone();
            signature.args.remove(0);
            let mut args = public_arguments(&signature, true, false, false);
            if abort {
                args = append_parameter(&args, "options?: CallOptions");
            }
            body.push_str(&format!(
                "{}({args}):Promise<{}>;",
                json(method),
                signature.result
            ));
        }
        types = types.replace(
            &format!("export type {name} = Resource<{}>;", json(name)),
            &format!(
                "export type {name} = Resource<{}> & {{{body}}};",
                json(name)
            ),
        );
    }
    if abort {
        types.push_str("export interface CallOptions { readonly signal?: AbortSignal; }\nexport interface HostContext { readonly signal: AbortSignal; }\n");
    }
    types.push_str(if abi.resource_types {
        "export interface AppBindings<Resources extends ResourceTypes = ResourceTypes> {\n"
    } else {
        "export interface AppBindings {\n"
    });
    let mut groups = std::collections::BTreeMap::<String, String>::new();
    for ((_, name), (args, result)) in &abi.imports {
        if abi.codecs.contains_key(name)
            || abi
                .live_imports
                .as_ref()
                .is_some_and(|live| !live.contains(name))
        {
            continue;
        }
        if abi.interface_members.get(name).is_some_and(|m| m.receiver) {
            continue;
        }
        let start = types.len();
        let public = abi.public_imports.get(name);
        let ret = public
            .map(|s| s.result.as_str())
            .unwrap_or_else(|| result.map(ts_type).unwrap_or("void"));
        let host_ret = if abi.resource_types {
            format!("HostValue<{ret}, Resources>")
        } else {
            ret.into()
        };
        let ret = host_ret.as_str();
        let input = if public.is_some() {
            input_type(ret)
        } else {
            ret.into()
        };
        let asynchronous = public.is_some_and(|s| s.asynchronous)
            || matches!(
                result,
                Some(Abi::FutureI32 | Abi::FutureVoid | Abi::FutureValue)
            );
        let args = public
            .map(|s| public_arguments(s, false, abort, abi.resource_types))
            .unwrap_or_else(|| arguments(args));
        let args = if abort {
            append_parameter(&args, "context: HostContext")
        } else {
            args
        };
        types.push_str(&format!(
            "{}: ({}) => {input}{};\n",
            json(name),
            args,
            if jspi || asynchronous {
                format!(" | PromiseLike<{input}>")
            } else {
                String::new()
            }
        ));
        if let Some(m) = abi.interface_members.get(name) {
            let line = types
                .split_off(start)
                .replacen(&json(name), &json(&m.method), 1);
            groups
                .entry(m.namespace.clone())
                .or_default()
                .push_str(&line);
        }
    }
    for (namespace, body) in groups {
        types.push_str(&format!("{}: {{{body}}};\n", json(&namespace)));
    }
    types.push_str("}\nexport interface AppExports {\n");
    let mut groups = std::collections::BTreeMap::<String, String>::new();
    for (name, (args, result)) in &abi.exports {
        if abi
            .guest_resources
            .values()
            .any(|g| &g.drop_export == name || g.methods.values().any(|n| n == name))
        {
            continue;
        }
        let start = types.len();
        let public = abi.public_exports.get(name);
        let args = public
            .map(|s| public_arguments(s, true, false, false))
            .unwrap_or_else(|| arguments(args));
        let args = if abort {
            append_parameter(&args, "options?: CallOptions")
        } else {
            args
        };
        types.push_str(&format!(
            "{}({}): Promise<{}>;\n",
            json(name),
            args,
            public
                .map(|s| s.result.as_str())
                .unwrap_or_else(|| result.map(ts_type).unwrap_or("void"))
        ));
        if let Some(m) = abi.interface_members.get(name) {
            let line = types
                .split_off(start)
                .replacen(&json(name), &json(&m.method), 1);
            groups
                .entry(m.namespace.clone())
                .or_default()
                .push_str(&line);
        }
    }
    for (namespace, body) in groups {
        types.push_str(&format!("readonly {}: {{{body}}};\n", json(&namespace)));
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
dispose(): void;
stats: {runtime_host}['stats'];
"#
    ));
    if !jspi {
        types.push_str("cancel: Host['cancel'];\nactiveTasks: Host['activeTasks'];\n");
    }
    let optional = if abi.imports.keys().all(|(_, name)| {
        abi.codecs.contains_key(name)
            || abi.interface_members.get(name).is_some_and(|m| m.receiver)
            || abi
                .live_imports
                .as_ref()
                .is_some_and(|live| !live.contains(name))
    }) {
        "?"
    } else {
        ""
    };
    let generic = if abi.resource_types {
        "<Resources extends ResourceTypes = ResourceTypes>"
    } else {
        ""
    };
    let argument = if abi.resource_types {
        "<Resources>"
    } else {
        ""
    };
    types.push_str(&format!(r#"}}
export type AppHostOptions{generic} = Omit<{host_options}, 'bindings'> & {{ bindings{optional}: AppBindings{argument} }};
export function createHost{generic}(options{optional}: AppHostOptions{argument}): AppHost;
"#));
    types
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_explicit_and_preserves_optional_wit_argument_positions() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app.wit");
        std::fs::write(&path, "package test:cancel; world app {import wait:async func(v:option<u32>)->u32; export run:async func(v:option<u32>)->u32;}").unwrap();
        let abi = crate::wit::parse(&path, None).unwrap();
        let (plain, plain_ts) = generate(&abi, false, Features::default()).unwrap();
        assert!(!plain.contains("signal"));
        assert!(!plain_ts.contains("AbortSignal"));
        let (js, ts) = generate_with_abort(&abi, false, Features::default(), true).unwrap();
        assert!(js.contains("async (a0, options) => call(\"run\", options?.signal, a0)"));
        assert!(ts.contains("context: HostContext"));
        assert!(ts.contains("options?: CallOptions"));
        assert!(ts.contains("readonly signal?: AbortSignal"));
        assert!(generate_with_abort(&abi, true, Features::default(), true).is_err());
    }

    #[test]
    fn rejects_host_collisions_including_thenable_exports() {
        for name in [
            "imports",
            "attach",
            "stats",
            "cancel",
            "activeTasks",
            "dispose",
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
            assert!(!js.contains("host.promise("));
        }
    }
    #[test]
    fn import_free_hosts_need_no_options() {
        let (_, types) = generate(&Bindings::default(), true, Features::default()).unwrap();
        assert!(types.contains("createHost(options?: AppHostOptions)"));
    }
}

#[cfg(test)]
mod compact_tests {
    use super::*;
    #[test]
    fn compact_names_avoid_public_imports_and_share_identical_codecs() {
        let mut abi = Bindings::default();
        for name in [
            "a",
            "taraba-codec-1-encode",
            "taraba-codec-2-decode",
            "taraba-codec-3-len",
        ] {
            abi.imports
                .insert(("app".into(), name.into()), (vec![], None));
        }
        abi.codecs
            .insert("taraba-codec-1-encode".into(), "v=>v".into());
        abi.codecs
            .insert("taraba-codec-2-decode".into(), "v=>v".into());
        abi.codecs
            .insert("taraba-codec-3-len".into(), "v=>v.length".into());
        compact_imports(&mut abi);
        assert_eq!(abi.wire_names["taraba-codec-1-encode"], "b");
        assert_eq!(abi.wire_names["taraba-codec-2-decode"], "b");
        assert_eq!(abi.wire_names["taraba-codec-3-len"], "c");
        let (js, ts) = generate(&abi, false, Features::default()).unwrap();
        assert!(!js.contains("taraba-codec"));
        assert_eq!(js.matches("v=>v,").count(), 1);
        assert!(!ts.contains("taraba-codec"));
        abi.live_imports = Some(abi.codecs.keys().cloned().collect());
        compact_imports(&mut abi);
        assert_eq!(
            abi.wire_names["taraba-codec-1-encode"], "a",
            "unused public imports must add zero deployed bytes"
        );
    }
}
