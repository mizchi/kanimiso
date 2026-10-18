//! Private Core ABI lowering. Standard Components bypass this module.
use walrus::{ExportItem, FunctionBuilder, FunctionKind, ImportKind, Module, RefType, ValType};

#[derive(Clone, Copy)]
pub(crate) enum Abi {
    I32,
    U32,
    F64,
    Borrow,
    Own,
}
use Abi::*;
impl Abi {
    fn raw(self) -> ValType {
        match self {
            F64 => ValType::F64,
            _ => ValType::I32,
        }
    }
    fn external(self) -> ValType {
        match self {
            Borrow | Own => ValType::Ref(RefType::EXTERNREF),
            U32 => ValType::F64,
            _ => self.raw(),
        }
    }
    fn reference(self) -> bool {
        matches!(self, Borrow | Own)
    }
}
pub(crate) type Signature = (Vec<Abi>, Option<Abi>);
#[derive(Default)]
pub(crate) struct Bindings {
    pub(crate) imports: std::collections::BTreeMap<(String, String), Signature>,
    pub(crate) exports: std::collections::BTreeMap<String, Signature>,
    pub(crate) drops: Vec<(String, String)>,
}
// JS-local contract: Number tokens and f64 scalar codec; no i64 boundary values.
fn import_abi(name: &str) -> Option<(&'static [Abi], Option<Abi>)> {
    Some(match name {
        "number" => (&[I32], Some(Own)),
        "exhausted" => (&[], Some(Own)),
        "as_i32" => (&[Borrow], Some(F64)),
        "task_promise" => (&[I32], Some(Own)),
        "task_finish" => (&[I32, Own, I32], None),
        "subscribe" => (&[Borrow, I32], Some(I32)),
        "deferred_add" => (&[I32, I32], Some(Own)),
        _ => return None,
    })
}
fn export_abi(name: &str) -> Option<(&'static [Abi], Option<Abi>)> {
    match name {
        "rt_settle" => Some((&[I32, Own, I32], None)),
        _ => None,
    }
}
#[cfg(test)]
fn lower(bytes: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    lower_with_abi(bytes, &Bindings::default())
}
pub(crate) fn lower_with_abi(
    bytes: &[u8],
    abi: &Bindings,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut m = Module::from_buffer(bytes)?;
    // Generated Canonical-ABI metadata/realloc are inapplicable after Core
    // externref lowering. They must not claim this module is a Component guest.
    let sections: Vec<_> = m
        .customs
        .iter()
        .filter(|(_, s)| s.name().starts_with("component-type"))
        .map(|(id, _)| id)
        .collect();
    if !sections.is_empty() {
        for id in sections {
            m.customs.delete(id);
        }
        let helpers: Vec<_> = m
            .exports
            .iter()
            .filter(|e| e.name == "cabi_realloc" || e.name.starts_with("cabi_realloc_wit_bindgen_"))
            .map(|e| e.id())
            .collect();
        for id in helpers {
            m.exports.delete(id);
        }
    }

    for import in m.imports.iter_mut() {
        if abi
            .drops
            .contains(&(import.module.clone(), import.name.clone()))
        {
            let ImportKind::Function(f) = import.kind else {
                return Err("resource drop must be a function".into());
            };
            let ty = m.types.get(m.funcs.get(f).ty());
            if ty.params() != [ValType::I32] || !ty.results().is_empty() {
                return Err("resource drop ABI mismatch".into());
            }
            import.module = "jsrt".into();
            import.name = "release".into();
        }
    }
    for import in m.imports.iter() {
        if import.module != "jsrt"
            && import.module != "pool"
            && !abi
                .imports
                .contains_key(&(import.module.clone(), import.name.clone()))
        {
            return Err(format!(
                "application import is missing from WIT: {}.{}",
                import.module, import.name
            )
            .into());
        }
    }
    for name in abi.exports.keys() {
        if !m
            .exports
            .iter()
            .any(|e| e.name == *name && matches!(e.item, ExportItem::Function(_)))
        {
            return Err(format!("missing ABI export: {name}").into());
        }
    }
    let imports: Vec<_> = m
        .imports
        .iter()
        .filter_map(|i| match i.kind {
            ImportKind::Function(f) => {
                let signature = if i.module == "jsrt" {
                    import_abi(&i.name).map(|(a, r)| (a.to_vec(), r))
                } else {
                    abi.imports
                        .get(&(i.module.clone(), i.name.clone()))
                        .cloned()
                };
                signature.map(|signature| (i.id(), f, i.module.clone(), i.name.clone(), signature))
            }
            _ => None,
        })
        .collect();
    let exports: Vec<_> = m
        .exports
        .iter()
        .filter_map(|e| match e.item {
            ExportItem::Function(f) => abi
                .exports
                .get(&e.name)
                .cloned()
                .or_else(|| export_abi(&e.name).map(|(a, r)| (a.to_vec(), r)))
                .map(|signature| (e.id(), f, signature)),
            _ => None,
        })
        .collect();
    if imports.is_empty() && exports.is_empty() {
        return Ok(m.emit_wasm());
    }
    let (table, _) = m.add_import_table("jsrt", "__values", false, 128, None, RefType::EXTERNREF);
    let root_ty = m
        .types
        .add(&[ValType::Ref(RefType::EXTERNREF)], &[ValType::I32]);
    let take_ty = m
        .types
        .add(&[ValType::I32], &[ValType::Ref(RefType::EXTERNREF)]);
    let (root, _) = m.add_import_func("jsrt", "__root", root_ty);
    let (take, _) = m.add_import_func("jsrt", "__take", take_ty);
    for (import, original, module, name, (args, result)) in imports {
        let raw_args: Vec<_> = args.iter().map(|a| a.raw()).collect();
        let raw_result: Vec<_> = result.map(Abi::raw).into_iter().collect();
        let original_type = m.funcs.get(original).ty();
        let ty = m.types.get(original_type);
        if ty.params() != raw_args || ty.results() != raw_result {
            return Err(format!("import ABI mismatch: {name}").into());
        }
        let external_args: Vec<_> = args.iter().map(|a| a.external()).collect();
        let external_result: Vec<_> = result.map(Abi::external).into_iter().collect();
        let external_ty = m.types.add(&external_args, &external_result);
        let (external, _) = m.add_import_func(
            if module == "jsrt" { "jsrt" } else { "app" },
            &name,
            external_ty,
        );
        let locals: Vec<_> = raw_args.iter().map(|t| m.locals.add(*t)).collect();
        let mut b = FunctionBuilder::new(&mut m.types, &raw_args, &raw_result);
        b.name(format!("externref_import_{name}"));
        let mut body = b.func_body();
        for (arg, local) in args.iter().zip(&locals) {
            body.local_get(*local);
            match arg {
                U32 => {
                    body.unop(walrus::ir::UnaryOp::F64ConvertUI32);
                }
                Borrow => {
                    body.table_get(table);
                }
                Own => {
                    body.call(take);
                }
                _ => {}
            }
        }
        body.call(external);
        if matches!(result, Some(U32)) {
            body.unop(walrus::ir::UnaryOp::I32TruncUSatF64);
        }
        if result.is_some_and(Abi::reference) {
            body.call(root);
        }
        let wrapper = b.finish(locals, &mut m.funcs);
        let kind = core::mem::replace(
            &mut m.funcs.get_mut(wrapper).kind,
            FunctionKind::Uninitialized(original_type),
        );
        // Preserve the original FunctionId: every Rust call now reaches the shim.
        m.funcs.get_mut(original).kind = kind;
        m.funcs.delete(wrapper);
        m.imports.delete(import);
    }
    for (export, original, (args, result)) in exports {
        let raw_args: Vec<_> = args.iter().map(|a| a.raw()).collect();
        let raw_result: Vec<_> = result.map(Abi::raw).into_iter().collect();
        let ty = m.types.get(m.funcs.get(original).ty());
        if ty.params() != raw_args || ty.results() != raw_result {
            return Err(format!("export ABI mismatch: {}", m.exports.get(export).name).into());
        }
        let external_args: Vec<_> = args.iter().map(|a| a.external()).collect();
        let external_result: Vec<_> = result.map(Abi::external).into_iter().collect();
        let locals: Vec<_> = external_args.iter().map(|t| m.locals.add(*t)).collect();
        let mut b = FunctionBuilder::new(&mut m.types, &external_args, &external_result);
        b.name(format!("externref_export_{}", m.exports.get(export).name));
        let mut body = b.func_body();
        for (arg, local) in args.iter().zip(&locals) {
            body.local_get(*local);
            if matches!(arg, U32) {
                body.unop(walrus::ir::UnaryOp::I32TruncUSatF64);
            }
            if arg.reference() {
                body.call(root);
            }
        }
        body.call(original);
        if matches!(result, Some(U32)) {
            body.unop(walrus::ir::UnaryOp::F64ConvertUI32);
        }
        if result.is_some_and(Abi::reference) {
            body.call(take);
        }
        let wrapper = b.finish(locals, &mut m.funcs);
        m.exports.get_mut(export).item = ExportItem::Function(wrapper);
    }
    walrus::passes::gc::run(&mut m);
    Ok(m.emit_wasm())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_old_i64_tokens() {
        let old = wat::parse_str(
            r#"(module (import "jsrt" "task_promise" (func (param i64) (result i32))))"#,
        )
        .unwrap();
        assert!(
            lower(&old)
                .unwrap_err()
                .to_string()
                .contains("ABI mismatch")
        );
    }
    #[test]
    fn undeclared_application_import_is_an_error() {
        let abi =
            crate::wit::parse_text("package test:app; world app {export run:func();}").unwrap();
        let raw = wat::parse_str(
            r#"(module (import "app" "hidden" (func $f)) (func (export "run") call $f))"#,
        )
        .unwrap();
        assert!(lower_with_abi(&raw, &abi).is_err());
    }
    #[test]
    fn wit_lowers_owned_resources_and_validates_actual_signatures() {
        let abi = crate::wit::parse_text(r#"package test:app; interface js { resource value; } world app { import js; use js.{value}; import identity: func(v: value) -> value; export mirror: func(v: value) -> value; }"#).unwrap();
        let raw=wat::parse_str(r#"(module (import "$root" "identity" (func $f (param i32) (result i32))) (func (export "mirror") (param i32) (result i32) local.get 0 call $f))"#).unwrap();
        let out = lower_with_abi(&raw, &abi).unwrap();
        let m = Module::from_buffer(&out).unwrap();
        let f = m.imports.get_func("app", "identity").unwrap();
        assert_eq!(
            m.types.get(m.funcs.get(f).ty()).params(),
            &[ValType::Ref(RefType::EXTERNREF)]
        );
        assert!(lower_with_abi(&wat::parse_str("(module)").unwrap(), &abi).is_err());
    }
}
