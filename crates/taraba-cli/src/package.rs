//! Distribution is separate from execution: prepare npm files without publishing them.
use crate::{BuildOptions, ComponentOptions, ExecutionProfile, component};
use std::{error::Error, fs, path::Path};
type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub struct NpmOptions {
    pub name: String,
    pub version: String,
    /// Use an SPDX identifier/expression, or UNLICENSED for private applications.
    pub license: String,
}
impl NpmOptions {
    pub fn validate(&self) -> Result<()> {
        let part = |s: &str| {
            !s.is_empty()
                && !s.starts_with(['.', '_'])
                && s.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"-._".contains(&c))
        };
        let valid = if let Some(s) = self.name.strip_prefix('@') {
            s.split_once('/')
                .is_some_and(|(scope, name)| part(scope) && part(name))
        } else {
            part(&self.name)
        };
        if !valid || self.name.len() > 214 {
            return Err("invalid npm package name (use lowercase name or @scope/name)".into());
        }
        let (version, build) = self
            .version
            .split_once('+')
            .map_or((self.version.as_str(), None), |(a, b)| (a, Some(b)));
        let (core, pre) = version
            .split_once('-')
            .map_or((version, None), |(a, b)| (a, Some(b)));
        let numeric = |s: &str| {
            !s.is_empty()
                && s.bytes().all(|b| b.is_ascii_digit())
                && (s.len() == 1 || !s.starts_with('0'))
        };
        let ids = |s: &str, prerelease: bool| {
            s.split('.').all(|s| {
                !s.is_empty()
                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    && (!prerelease || !s.bytes().all(|b| b.is_ascii_digit()) || numeric(s))
            })
        };
        if core.split('.').count() != 3
            || !core.split('.').all(numeric)
            || pre.is_some_and(|s| !ids(s, true))
            || build.is_some_and(|s| !ids(s, false))
        {
            return Err("npm version must be a SemVer version, e.g. 0.1.0 or 0.1.0-beta.1".into());
        }
        if self.license.trim().is_empty() {
            return Err("npm license must not be empty".into());
        }
        Ok(())
    }
}
fn json(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}
fn manifest(
    o: &NpmOptions,
    files: &[String],
    entry: &str,
    types: &str,
    component: bool,
) -> Result<Vec<u8>> {
    let mut exports = serde_json::json!({
        ".":{"types":format!("./{types}"),"import":format!("./{entry}")},
        "./package.json":"./package.json"
    });
    if component {
        exports["./component.wasm"] = "./app.component.wasm".into();
        exports["./wit"] = "./app.wit".into();
    } else {
        exports["./app.wasm"] = "./app.wasm".into();
        exports["./wit/*"] = "./wit/*".into();
    }
    Ok(serde_json::to_vec_pretty(&serde_json::json!({
        "name":o.name, "version":o.version, "license":o.license, "type":"module",
        "main":format!("./{entry}"),"types":format!("./{types}"),"exports":exports,"files":files,
        "sideEffects":false
    }))?)
}
fn collect(root: &Path, dir: &Path, files: &mut Vec<String>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            collect(root, &entry.path(), files)?;
        } else if entry.file_type()?.is_file() {
            files.push(
                entry
                    .path()
                    .strip_prefix(root)?
                    .to_str()
                    .ok_or("non-UTF8 output path")?
                    .replace('\\', "/"),
            );
        } else {
            return Err("unexpected generated file type".into());
        }
    }
    Ok(())
}
fn finish(
    temp: &Path,
    dest: &Path,
    o: &NpmOptions,
    entry: &str,
    types: &str,
    component: bool,
) -> Result<()> {
    fs::write(temp.join("LICENSE.taraba"), include_bytes!("../LICENSE"))?;
    let mut files = Vec::new();
    collect(temp, temp, &mut files)?;
    files.sort();
    let mut info: serde_json::Value = serde_json::from_slice(&fs::read(temp.join("build.json"))?)?;
    let bytes = |suffix: &str| -> Result<u64> {
        files
            .iter()
            .filter(|s| s.ends_with(suffix))
            .try_fold(0, |n, s| Ok(n + fs::metadata(temp.join(s))?.len()))
    };
    info["npm"] = serde_json::json!({"name":o.name,"version":o.version,"license":o.license,
        "entry":entry,"types":types,"runtime_js_bytes":bytes(".js")? + bytes(".mjs")?,
        "packaged_wasm_bytes":bytes(".wasm")?,"component_container_included":component,
        "declarations_bytes":bytes(".d.ts")? + bytes(".d.mts")?});
    fs::write(temp.join("build.json"), serde_json::to_vec_pretty(&info)?)?;
    let package = manifest(o, &files, entry, types, component)?;
    for file in &files {
        let out = dest.join(file);
        fs::create_dir_all(out.parent().unwrap())?;
        fs::copy(temp.join(file), out)?;
    }
    fs::write(dest.join("package.json"), package)?;
    println!(
        "Prepared {}@{} in {} (not published)",
        o.name,
        o.version,
        dest.display()
    );
    Ok(())
}

/// Produce a standard Component and jco's JavaScript/TypeScript library as an npm directory.
/// `jco` is a build-time executable, never a dependency of the generated package.
pub fn package_component(o: &ComponentOptions, npm: &NpmOptions, jco: &Path) -> Result<()> {
    npm.validate()?;
    prevent_input_overwrite(&o.input, &o.output.join("app.component.wasm"))?;
    let jco_version = component::command(jco, &["--version".as_ref()])?;
    if String::from_utf8_lossy(&jco_version).trim() != "1.39.0" {
        return Err("Component npm builds require jco 1.39.0".into());
    }
    let temp = tempfile::tempdir()?;
    let component_dir = temp.path().join("component");
    let js = temp.path().join("npm");
    let local = ComponentOptions {
        input: o.input.clone(),
        wit: o.wit.clone(),
        world: o.world.clone(),
        output: component_dir.clone(),
        binaryen: o.binaryen.clone(),
        wasm_tools: o.wasm_tools.clone(),
    };
    crate::build_component(&local)?;
    let (r, world) = component::resolve(&o.wit, o.world.as_deref())?;
    let mut args: Vec<std::ffi::OsString> = vec![
        "transpile".into(),
        component_dir.join("app.component.wasm").into_os_string(),
    ];
    for s in [
        "--name",
        "app",
        "--instantiation",
        "async",
        "--async-mode",
        "jspi",
        "--no-wasi-shim",
        "--no-nodejs-compat",
        "--minify",
        "--bindgen-enable-wasm-exnref",
        "--base64-cutoff",
        "0",
    ] {
        args.push(s.into());
    }
    for (flag, export) in [("--async-imports", false), ("--async-exports", true)] {
        let functions = component::async_functions(&r, world, export);
        if !functions.is_empty() {
            args.push(flag.into());
            args.extend(functions.into_iter().map(Into::into));
        }
    }
    args.extend(["-o".into(), js.as_os_str().into()]);
    component::command(jco, &args.iter().map(|s| s.as_os_str()).collect::<Vec<_>>())?;
    for name in ["app.component.wasm", "app.wit", "build.json"] {
        fs::copy(component_dir.join(name), js.join(name))?;
    }
    // jco's named interfaces and async return types remain the sole source of TS types.
    finish(&js, &o.output, npm, "app.js", "app.d.ts", true)
}

fn ts_type(ty: crate::abi::Abi) -> &'static str {
    match ty {
        crate::abi::Abi::I32 | crate::abi::Abi::U32 | crate::abi::Abi::F64 => "number",
        _ => "unknown",
    }
}
fn arguments(args: &[crate::abi::Abi]) -> String {
    args.iter()
        .enumerate()
        .map(|(i, t)| format!("a{i}: {}", ts_type(*t)))
        .collect::<Vec<_>>()
        .join(", ")
}
/// Produce a lightweight Core npm package with an application-specific typed exports object.
/// Opaque WIT resource payloads stay `unknown`; use Component WIT for typed async results.
pub fn package_core(o: &BuildOptions, npm: &NpmOptions) -> Result<()> {
    npm.validate()?;
    prevent_input_overwrite(&o.input, &o.output.join("app.wasm"))?;
    let abi = crate::wit::parse(&o.wit, o.world.as_deref())?;
    let temp = tempfile::tempdir()?;
    let local = BuildOptions {
        input: o.input.clone(),
        wit: o.wit.clone(),
        world: o.world.clone(),
        output: temp.path().to_owned(),
        binaryen: o.binaryen.clone(),
        debug: o.debug,
        probes: o.probes,
        profile: o.profile,
    };
    crate::build(&local)?;
    let jspi = o.profile == ExecutionProfile::Jspi;
    let mut js = String::from(
        "import { instantiate as runtime } from './taraba.mjs';\nexport async function instantiate(source, options) {\nconst host = await runtime(source, options);\nreturn { exports: {\n",
    );
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
        js.push_str(&format!(
            "[{}]: (...args) => host.promise({}, ...args),\n",
            json(name),
            json(name)
        ));
        types.push_str(&format!(
            "{}({}): Promise<{}>;\n",
            json(name),
            arguments(args),
            result.map(ts_type).unwrap_or("void")
        ));
    }
    js.push_str("}, stats: host.stats");
    let (runtime_host, options) = if jspi {
        ("JspiHost", "JspiOptions")
    } else {
        ("Host", "InstantiateOptions")
    };
    types.push_str(&format!("}}\nimport type {{ {runtime_host}, {options} }} from './taraba.mjs';\nexport interface AppHost {{\nexports: AppExports;\nstats: {runtime_host}['stats'];\n"));
    if !jspi {
        js.push_str(", cancel: host.cancel, activeTasks: host.activeTasks");
        types.push_str("cancel: Host['cancel'];\nactiveTasks: Host['activeTasks'];\n");
    }
    js.push_str("};\n}\n");
    types.push_str(&format!("}}\nexport function instantiate(source: BufferSource | WebAssembly.Module, options: Omit<{options}, 'bindings'> & {{ bindings: AppBindings }}): Promise<AppHost>;\n"));
    fs::write(temp.path().join("index.mjs"), js)?;
    fs::write(temp.path().join("index.d.mts"), types)?;
    copy_wit(&o.wit, &temp.path().join("wit"))?;
    finish(
        temp.path(),
        &o.output,
        npm,
        "index.mjs",
        "index.d.mts",
        false,
    )
}

fn prevent_input_overwrite(input: &Path, output: &Path) -> Result<()> {
    if output.exists() && fs::canonicalize(input)? == fs::canonicalize(output)? {
        return Err("output must not overwrite input".into());
    }
    Ok(())
}
fn copy_wit(input: &Path, output: &Path) -> Result<()> {
    let input = fs::canonicalize(input)?;
    let root = if input.is_dir() {
        input.as_path()
    } else {
        input.parent().ok_or("WIT path has no parent")?
    };
    let (_, sources) = wit_parser::Resolve::default().push_path(&input)?;
    for source in sources.paths() {
        let dest = output.join(source.strip_prefix(root)?);
        fs::create_dir_all(dest.parent().unwrap())?;
        fs::copy(source, dest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_npm_identity_before_building() {
        for (name, version) in [
            ("Upper", "1.0.0"),
            ("@scope/../file", "1.0.0"),
            ("ok", "v1.0.0"),
            ("ok", "01.0.0"),
            ("ok", "1.0.0-01"),
            ("ok", "1.0.0+"),
        ] {
            assert!(
                NpmOptions {
                    name: name.into(),
                    version: version.into(),
                    license: "MIT".into()
                }
                .validate()
                .is_err()
            );
        }
        for version in ["0.1.0", "1.2.3-beta.1+build.42"] {
            assert!(
                NpmOptions {
                    name: "@example/library".into(),
                    version: version.into(),
                    license: "UNLICENSED".into()
                }
                .validate()
                .is_ok()
            );
        }
    }
}
