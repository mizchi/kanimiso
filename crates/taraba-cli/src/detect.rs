use crate::{BuildOptions, ExecutionProfile};
use std::{error::Error, fs};

/// Select the Core host from the compiled guest and its public WIT contract.
/// Component output remains an explicit distribution choice.
pub fn detect_core_profile(o: &BuildOptions) -> Result<ExecutionProfile, Box<dyn Error>> {
    let bindings = crate::wit::parse(&o.wit, o.world.as_deref())?;
    let module = walrus::Module::from_buffer(&fs::read(&o.input)?)?;
    Ok(
        if bindings.uses_resource_handles()
            || module.imports.iter().any(|i| {
                bindings
                    .drops
                    .iter()
                    .any(|(module, name)| i.module == *module && i.name == *name)
            })
            || module
                .imports
                .iter()
                .any(|i| matches!(i.module.as_str(), "jsrt" | "pool"))
            || module
                .exports
                .iter()
                .any(|e| matches!(e.name.as_str(), "rt_poll" | "rt_drop" | "rt_settle"))
        {
            ExecutionProfile::Future
        } else {
            ExecutionProfile::Jspi
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn compiled_runtime_requirements_and_resources_select_the_core_host() {
        let root = tempfile::tempdir().unwrap();
        let wit = root.path().join("app.wit");
        let input = root.path().join("app.wasm");
        for (source, contract, expected) in [
            (
                "(module (import \"taraba:panic\" \"report\" (func (param i32 i32))))",
                "",
                ExecutionProfile::Jspi,
            ),
            (
                "(module)",
                "export async-future: func();",
                ExecutionProfile::Jspi,
            ),
            (
                "(module (import \"jsrt\" \"promise_new\" (func)))",
                "",
                ExecutionProfile::Future,
            ),
            (
                "(module (import \"pool\" \"allocate\" (func)))",
                "",
                ExecutionProfile::Future,
            ),
            (
                "(module (func (export \"rt_poll\")))",
                "",
                ExecutionProfile::Future,
            ),
            (
                "(module (import \"test:detect/js\" \"[resource-drop]promise\" (func (param i32))))",
                "import js;",
                ExecutionProfile::Future,
            ),
            (
                "(module)",
                "import js; use js.{promise}; export run: func() -> promise;",
                ExecutionProfile::Future,
            ),
        ] {
            fs::write(&input, wat::parse_str(source).unwrap()).unwrap();
            fs::write(&wit, format!("package test:detect; interface js {{ resource promise; }} world app {{ {contract} }}")).unwrap();
            let options = BuildOptions {
                input: input.clone(),
                wit: wit.clone(),
                world: None,
                output: PathBuf::new(),
                binaryen: None,
                debug: false,
                probes: false,
                abort_signal: false,
                task_slots: None,
                insight: false,
                profile: ExecutionProfile::Jspi,
            };
            assert_eq!(detect_core_profile(&options).unwrap(), expected);
        }
    }
}
