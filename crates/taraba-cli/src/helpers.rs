//! Optional private memory ABI, checked against the shipped WIT contract.
use crate::{abi::Abi, wit};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
};
use walrus::{ExportItem, ImportKind, Module, ValType};

fn write_asset(
    output: &std::path::Path,
    name: &str,
    asset: Option<&[u8]>,
) -> Result<usize, Box<dyn Error>> {
    let dest = output.join(format!("helpers-{name}.mjs"));
    if let Some(asset) = asset {
        std::fs::write(dest, asset)?;
        Ok(asset.len())
    } else {
        match std::fs::remove_file(dest) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        Ok(0)
    }
}

pub(crate) fn write_regexp(
    output: &std::path::Path,
    enabled: bool,
    debug: bool,
) -> Result<usize, Box<dyn Error>> {
    let asset = if debug {
        include_bytes!("../assets/regexp-debug.mjs").as_slice()
    } else {
        include_bytes!("../assets/regexp.mjs").as_slice()
    };
    write_asset(output, "regexp", enabled.then_some(asset))
}

pub(crate) const REGEXP: &str = "taraba:helpers/regexp@0.1.0";
pub(crate) const VALUES: &str = "taraba:helpers/values@0.1.0";
pub(crate) const STRINGS: &str = "taraba:helpers/strings@0.1.0";
pub(crate) const ITERATOR: &str = "taraba:helpers/iterator@0.1.0";
pub(crate) const SEGMENTER: &str = "taraba:helpers/segmenter@0.1.0";
pub(crate) const ENCODING: &str = "taraba:helpers/encoding@0.1.0";
pub(crate) fn known_module(module: &str) -> bool {
    matches!(
        module,
        REGEXP | VALUES | STRINGS | ITERATOR | SEGMENTER | ENCODING
    )
}
#[derive(Default, Clone)]
pub(crate) struct Features {
    used: BTreeMap<String, BTreeSet<String>>,
    pub regexp: bool,
    pub values: bool,
    pub strings: bool,
    pub iterator: bool,
    pub segmenter: bool,
    pub encoding: bool,
    pub regexp_strings: bool,
}
impl Features {
    pub fn detect(m: &Module) -> Self {
        let has = |module| m.imports.iter().any(|i| i.module == module);
        let regexp_strings = m.imports.iter().any(|i| {
            i.module == REGEXP && matches!(i.name.as_str(), "compile-string" | "test-string")
        });
        let strings = has(STRINGS);
        let iterator = has(ITERATOR);
        let segmenter = has(SEGMENTER);
        let encoding = has(ENCODING);
        let mut used: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for import in m.imports.iter().filter(|i| known_module(&i.module)) {
            used.entry(import.module.clone())
                .or_default()
                .insert(import.name.clone());
        }
        Self {
            used,
            regexp: has(REGEXP),
            values: has(VALUES) || strings || iterator || segmenter || encoding || regexp_strings,
            strings,
            iterator,
            segmenter,
            encoding,
            regexp_strings,
        }
    }
    pub fn any(&self) -> bool {
        self.regexp || self.values
    }
    pub fn write(&self, output: &std::path::Path, debug: bool) -> Result<usize, Box<dyn Error>> {
        let mut bytes = 0;
        // RegExp's UTF-8-only variant does not pay for the JS-string bridge.
        if self.regexp_strings {
            let asset = if debug {
                include_bytes!("../assets/regexp-strings-debug.mjs").as_slice()
            } else {
                include_bytes!("../assets/regexp-strings.mjs").as_slice()
            };
            std::fs::write(output.join("helpers-regexp.mjs"), asset)?;
            bytes += asset.len();
        } else {
            bytes += write_regexp(output, self.regexp, debug)?;
        }
        let values = if debug {
            include_bytes!("../assets/helper-values-debug.mjs").as_slice()
        } else {
            include_bytes!("../assets/helper-values.mjs").as_slice()
        };
        bytes += write_asset(output, "values", self.values.then_some(values))?;
        let operations: BTreeMap<String, BTreeMap<String, String>> =
            serde_json::from_str(include_str!("../assets/helper-operations.json"))?;
        for (name, module, factory) in [
            ("strings", STRINGS, "stringImports"),
            ("iterator", ITERATOR, "iteratorImports"),
            ("segmenter", SEGMENTER, "segmenterImports"),
            ("encoding", ENCODING, "encodingImports"),
        ] {
            if let Some(used) = self.used.get(module) {
                let mut js = format!("export function {factory}(v){{const a={{}};");
                for operation in used {
                    let closure = operations
                        .get(name)
                        .and_then(|ops| ops.get(operation))
                        .ok_or_else(|| {
                            format!("missing helper implementation: {module}/{operation}")
                        })?;
                    js.push('{');
                    js.push_str(closure);
                    js.push('}');
                }
                js.push_str("return a}\n");
                bytes += write_asset(output, name, Some(js.as_bytes()))?;
            } else {
                write_asset(output, name, None)?;
            }
        }
        Ok(bytes)
    }
}
pub(crate) fn validate(m: &Module) -> Result<(), Box<dyn Error>> {
    if !m.imports.iter().any(|i| known_module(&i.module)) {
        return Ok(());
    }
    let mut contract = wit::parse_private_helpers(include_str!("../assets/regexp.wit"))?;
    contract
        .imports
        .extend(wit::parse_private_helpers(include_str!("../assets/text.wit"))?.imports);
    if !m.exports.iter().any(|e| {
        e.name == "memory"
            && matches!(e.item, ExportItem::Memory(id) if !m.memories.get(id).memory64)
    }) {
        return Err("taraba-helpers requires an exported wasm32 memory named memory".into());
    }
    for i in m.imports.iter().filter(|i| known_module(&i.module)) {
        let signature = contract
            .imports
            .get(&(i.module.clone(), i.name.clone()))
            .ok_or_else(|| format!("unknown taraba-helpers import: {}", i.name))?;
        let ImportKind::Function(f) = i.kind else {
            return Err("taraba-helpers import must be a function".into());
        };
        let ty = m.types.get(m.funcs.get(f).ty());
        // This private memory contract has only u32 values. It is deliberately
        // not routed through public Core u32 <-> JS Number lifting.
        if !signature
            .0
            .iter()
            .chain(signature.1.iter())
            .all(|a| matches!(a, Abi::U32))
            || ty.params() != vec![ValType::I32; signature.0.len()]
            || ty.results() != vec![ValType::I32; usize::from(signature.1.is_some())]
        {
            return Err(format!("taraba-helpers ABI mismatch: {}", i.name).into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn operation_implementations_match_wit() {
        let operations: std::collections::BTreeMap<
            String,
            std::collections::BTreeMap<String, String>,
        > = serde_json::from_str(include_str!("../assets/helper-operations.json")).unwrap();
        let contract =
            crate::wit::parse_private_helpers(include_str!("../assets/text.wit")).unwrap();
        for (name, methods) in operations {
            let module = format!("taraba:helpers/{name}@0.1.0");
            let expected: std::collections::BTreeSet<_> = contract
                .imports
                .keys()
                .filter(|(m, _)| *m == module)
                .map(|(_, n)| n.clone())
                .collect();
            assert_eq!(
                methods
                    .keys()
                    .cloned()
                    .collect::<std::collections::BTreeSet<_>>(),
                expected,
                "{module}"
            );
        }
    }
    #[test]
    fn uppercase_does_not_retain_other_transforms() {
        let raw = wat::parse_str(
            r#"(module
          (import "taraba:helpers/strings@0.1.0" "to-uppercase" (func (param i32) (result i32)))
          (memory (export "memory") 1))"#,
        )
        .unwrap();
        let module = walrus::Module::from_buffer(&raw).unwrap();
        let dir = tempfile::tempdir().unwrap();
        super::validate(&module).unwrap();
        super::Features::detect(&module)
            .write(dir.path(), false)
            .unwrap();
        let js = std::fs::read_to_string(dir.path().join("helpers-strings.mjs")).unwrap();
        assert!(js.contains("toUpperCase"));
        for unused in [
            "TextEncoder",
            "TextDecoder",
            "normalize",
            "toLowerCase",
            "trim",
        ] {
            assert!(!js.contains(unused), "unused operation retained: {unused}");
        }
    }
    #[test]
    fn emits_only_imported_string_operations() {
        let raw = wat::parse_str(
            r#"(module
          (import "taraba:helpers/strings@0.1.0" "from-utf8" (func (param i32 i32) (result i32)))
          (import "taraba:helpers/strings@0.1.0" "utf16-len" (func (param i32) (result i32)))
          (memory (export "memory") 1))"#,
        )
        .unwrap();
        let module = walrus::Module::from_buffer(&raw).unwrap();
        let dir = tempfile::tempdir().unwrap();
        super::Features::detect(&module)
            .write(dir.path(), false)
            .unwrap();
        let js = std::fs::read_to_string(dir.path().join("helpers-strings.mjs")).unwrap();
        assert!(js.contains("from-utf8") && js.contains("utf16-len"));
        for unused in [
            "TextEncoder",
            "normalize",
            "toUpperCase",
            "Symbol.iterator",
            "copy-utf8",
        ] {
            assert!(!js.contains(unused), "unused operation retained: {unused}");
        }
    }
    #[test]
    fn typed_private_namespaces_keep_duplicate_new_names_and_clean_unused_modules() {
        let raw = wat::parse_str(
            r#"(module
          (import "taraba:helpers/strings@0.1.0" "normalize" (func (param i32 i32) (result i32)))
          (import "taraba:helpers/segmenter@0.1.0" "new" (func (param i32 i32) (result i32)))
          (import "taraba:helpers/encoding@0.1.0" "new" (func (param i32) (result i32)))
          (memory (export "memory") 1))"#,
        )
        .unwrap();
        let module = walrus::Module::from_buffer(&raw).unwrap();
        super::validate(&module).unwrap();
        let features = super::Features::detect(&module);
        assert!(features.values && features.strings && features.segmenter && features.encoding);
        let dir = tempfile::tempdir().unwrap();
        assert!(features.write(dir.path(), false).unwrap() > 0);
        assert!(dir.path().join("helpers-values.mjs").exists());
        assert!(dir.path().join("helpers-segmenter.mjs").exists());
        assert!(!dir.path().join("helpers-iterator.mjs").exists());
        super::Features::default().write(dir.path(), false).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        let wrong = wat::parse_str(
            r#"(module
          (import "taraba:helpers/strings@0.1.0" "normalize" (func (param i64 i32) (result i32)))
          (memory (export "memory") 1))"#,
        )
        .unwrap();
        assert!(super::validate(&walrus::Module::from_buffer(&wrong).unwrap()).is_err());
    }
    #[test]
    fn helper_assets_are_removed_when_rebuilding_without_the_feature() {
        let dir = tempfile::tempdir().unwrap();
        let size = super::write_regexp(dir.path(), true, false).unwrap();
        assert!(size > 0);
        assert!(dir.path().join("helpers-regexp.mjs").exists());
        assert_eq!(super::write_regexp(dir.path(), false, false).unwrap(), 0);
        assert!(!dir.path().join("helpers-regexp.mjs").exists());
        assert_eq!(super::write_regexp(dir.path(), false, false).unwrap(), 0);
    }
}
