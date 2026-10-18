//! Explicit ABI lowering for this experiment; not a general Rust binding generator.
use walrus::{ExportItem, FunctionBuilder, FunctionKind, ImportKind, Module, RefType, ValType};

#[derive(Clone, Copy)]
enum Abi {
    I32,
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
            _ => self.raw(),
        }
    }
    fn reference(self) -> bool {
        matches!(self, Borrow | Own)
    }
}
type Signature = (Vec<Abi>, Option<Abi>);
#[derive(Default)]
struct Bindings {
    imports: std::collections::BTreeMap<String, Signature>,
    exports: std::collections::BTreeMap<String, Signature>,
}
impl Bindings {
    fn parse(text: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let value: serde_json::Value = serde_json::from_str(text)?;
        let obj = value.as_object().ok_or("ABI manifest must be an object")?;
        let mut abi = Self::default();
        for (kind, entries) in obj {
            if kind != "imports" && kind != "exports" {
                return Err(format!("unknown ABI field: {kind}").into());
            }
            for (name, value) in entries
                .as_object()
                .ok_or("ABI interfaces must be objects")?
            {
                let entry = value.as_object().ok_or("ABI signature must be an object")?;
                if entry.len() != 2
                    || !entry.contains_key("params")
                    || !entry.contains_key("result")
                {
                    return Err("ABI signature requires only params and result".into());
                }
                let convert = |v: &serde_json::Value| -> Result<Abi, Box<dyn std::error::Error>> {
                    Ok(match v.as_str().ok_or("ABI type must be a string")? {
                        "i32" => I32,
                        "f64" => F64,
                        "own" => Own,
                        "borrow" => Borrow,
                        other => return Err(format!("unknown ABI type: {other}").into()),
                    })
                };
                let params = entry["params"]
                    .as_array()
                    .ok_or("params must be an array")?
                    .iter()
                    .map(convert)
                    .collect::<Result<Vec<_>, _>>()?;
                let result = if entry["result"].is_null() {
                    None
                } else {
                    Some(convert(&entry["result"])?)
                };
                if matches!(result, Some(Borrow))
                    || (kind == "exports" && params.iter().any(|v| matches!(v, Borrow)))
                {
                    return Err("borrow is supported only for import parameters".into());
                }
                if kind == "imports" {
                    if !name.starts_with("app.") || name.len() == 4 {
                        return Err("application imports must use the app. namespace".into());
                    }
                    abi.imports.insert(name.clone(), (params, result));
                } else {
                    if name.is_empty() || name.starts_with("rt_") {
                        return Err("application exports must not override the runtime ABI".into());
                    }
                    abi.exports.insert(name.clone(), (params, result));
                }
            }
        }
        Ok(abi)
    }
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
fn lower_with_abi(bytes: &[u8], abi: &Bindings) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut m = Module::from_buffer(bytes)?;
    for name in abi.imports.keys() {
        let (module, field) = name.split_once('.').unwrap();
        if m.imports.get_func(module, field).is_err() {
            return Err(format!("missing ABI import: {name}").into());
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
                        .get(&format!("{}.{}", i.module, i.name))
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
        let (external, _) = m.add_import_func(&module, &name, external_ty);
        let locals: Vec<_> = raw_args.iter().map(|t| m.locals.add(*t)).collect();
        let mut b = FunctionBuilder::new(&mut m.types, &raw_args, &raw_result);
        b.name(format!("externref_import_{name}"));
        let mut body = b.func_body();
        for (arg, local) in args.iter().zip(&locals) {
            body.local_get(*local);
            match arg {
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
            if arg.reference() {
                body.call(root);
            }
        }
        body.call(original);
        if result.is_some_and(Abi::reference) {
            body.call(take);
        }
        let wrapper = b.finish(locals, &mut m.funcs);
        m.exports.get_mut(export).item = ExportItem::Function(wrapper);
    }
    walrus::passes::gc::run(&mut m);
    Ok(m.emit_wasm())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--inspect" {
        let m = Module::from_file(&args[2])?;
        let signature = |f| {
            let ty = m.types.get(m.funcs.get(f).ty());
            serde_json::json!({"params": ty.params().iter().map(|v| format!("{v:?}")).collect::<Vec<_>>(),
                "results": ty.results().iter().map(|v| format!("{v:?}")).collect::<Vec<_>>()})
        };
        let imports: Vec<_> = m
            .imports
            .iter()
            .filter_map(|i| match i.kind {
                ImportKind::Function(f) => Some(
                    serde_json::json!({"module":i.module,"name":i.name,"signature":signature(f)}),
                ),
                _ => None,
            })
            .collect();
        let exports: Vec<_> = m
            .exports
            .iter()
            .filter_map(|e| match e.item {
                ExportItem::Function(f) => {
                    Some(serde_json::json!({"name":e.name,"signature":signature(f)}))
                }
                _ => None,
            })
            .collect();
        let tables: Vec<_> = m
            .tables
            .iter()
            .map(|t| format!("{:?}", t.element_ty))
            .collect();
        println!(
            "{}",
            serde_json::json!({"imports":imports,"exports":exports,"tables":tables})
        );
        return Ok(());
    }
    if args.len() != 3 && args.len() != 4 {
        return Err("usage: kanimiso-bind input.wasm output.wasm [abi.json]".into());
    }
    let abi = if args.len() == 4 {
        Bindings::parse(&std::fs::read_to_string(&args[3])?)?
    } else {
        Bindings::default()
    };
    std::fs::write(&args[2], lower_with_abi(&std::fs::read(&args[1])?, &abi)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn application_manifest_lowers_custom_names_and_rejects_invalid_contracts() {
        let schema = r#"{"imports":{"app.identity":{"params":["own"],"result":"own"}},"exports":{"mirror":{"params":["own"],"result":"own"}}}"#;
        let abi = Bindings::parse(schema).unwrap();
        let raw = wat::parse_str(
            r#"(module
          (import "app" "identity" (func $id (param i32) (result i32)))
          (func (export "mirror") (param i32) (result i32) local.get 0 call $id))"#,
        )
        .unwrap();
        let output = lower_with_abi(&raw, &abi).unwrap();
        let m = Module::from_buffer(&output).unwrap();
        let f = m.imports.get_func("app", "identity").unwrap();
        assert_eq!(
            m.types.get(m.funcs.get(f).ty()).params(),
            &[ValType::Ref(RefType::EXTERNREF)]
        );
        assert!(
            Bindings::parse(r#"{"exports":{"x":{"params":["borrow"],"result":null}}}"#).is_err()
        );
        assert!(Bindings::parse(r#"{"exports":{"x":{"params":[],"result":"borrow"}}}"#).is_err());
        assert!(
            Bindings::parse(r#"{"exports":{"x":{"params":["garbage"],"result":null}}}"#).is_err()
        );
        assert!(Bindings::parse(r#"{"exportz":{}}"#).is_err());
        assert!(
            Bindings::parse(r#"{"imports":{"jsrt.number":{"params":[],"result":null}}}"#).is_err()
        );
        assert!(lower_with_abi(&wat::parse_str("(module)").unwrap(), &abi).is_err());
    }
    #[test]
    fn native_reference_and_number_abi_rejects_old_i64_tokens() {
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
        let input = wat::parse_str(
            r#"(module
            (import "jsrt" "as_i32" (func $read (param i32) (result f64)))
            (func (export "start") (param i32 i32) (result i32)
             local.get 0 call $read drop local.get 1))"#,
        )
        .unwrap();
        let output = lower(&input).unwrap();
        let m = Module::from_buffer(&output).unwrap();
        let f = m.imports.get_func("jsrt", "as_i32").unwrap();
        let t = m.types.get(m.funcs.get(f).ty());
        assert_eq!(t.params(), &[ValType::Ref(RefType::EXTERNREF)]);
        assert_eq!(t.results(), &[ValType::F64]);
    }
}
