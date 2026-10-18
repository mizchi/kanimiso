use std::{error::Error, fs};
const HOOKS: &str = "taraba:jspi-stack";
fn instrument(bytes: &[u8], suspended: &[String]) -> Result<Vec<u8>, Box<dyn Error>> {
    use walrus::{
        ConstExpr, ExportItem, FunctionBuilder, FunctionKind, ImportKind, Module, RefType, ValType,
    };
    let mut m = Module::from_buffer(bytes)?;
    if m.start.is_some() || m.imports.iter().any(|i| i.module != "app") {
        return Err("only scalar app imports without start functions are supported".into());
    }
    let memories: Vec<_> = m.memories.iter().collect();
    if memories.len() != 1
        || memories[0].shared
        || memories[0].memory64
        || memories[0].import.is_some()
    {
        return Err("one local non-shared wasm32 memory is required".into());
    }
    let global = |name: &str| -> Result<_, Box<dyn Error>> {
        let id = m
            .exports
            .iter()
            .find_map(|e| match e.item {
                ExportItem::Global(id) if e.name == name => Some(id),
                _ => None,
            })
            .ok_or_else(|| {
                format!("missing {name}; explicitly export LLVM stack bounds and pointer")
            })?;
        let g = m.globals.get(id);
        if g.ty != ValType::I32 || g.mutable != (name == "__stack_pointer") || g.shared {
            return Err(format!("invalid {name}").into());
        }
        Ok(id)
    };
    let sp = global("__stack_pointer")?;
    global("__stack_low")?;
    global("__stack_high")?;
    let imports: Vec<_> = m
        .imports
        .iter()
        .map(|i| match i.kind {
            ImportKind::Function(f) => Ok((i.id(), f, i.name.clone())),
            _ => Err("only function imports are supported"),
        })
        .collect::<Result<_, _>>()?;
    let exports: Vec<_> = m
        .exports
        .iter()
        .filter_map(|e| match e.item {
            ExportItem::Function(f) => Some((e.id(), f)),
            _ => None,
        })
        .collect();
    if suspended
        .iter()
        .any(|name| !imports.iter().any(|(_, _, import)| import == name))
    {
        return Err("unknown suspending import".into());
    }
    for f in imports
        .iter()
        .map(|(_, f, _)| *f)
        .chain(exports.iter().map(|(_, f)| *f))
    {
        let t = m.types.get(m.funcs.get(f).ty());
        if t.results().len() > 1
            || t.params()
                .iter()
                .chain(t.results())
                .any(|t| !matches!(t, ValType::I32 | ValType::F64))
        {
            return Err("only scalar i32/f64 boundaries are supported".into());
        }
    }
    let marker = m.globals.add_local(
        ValType::I32,
        false,
        false,
        ConstExpr::Value(walrus::ir::Value::I32(1)),
    );
    m.exports.add("rt_jspi_stack", marker);
    let reference = ValType::Ref(RefType::EXTERNREF);
    let current = m.globals.add_local(
        reference,
        true,
        false,
        ConstExpr::RefNull(RefType::EXTERNREF),
    );
    let ty = m.types.add(&[], &[reference]);
    let (enter, _) = m.add_import_func(HOOKS, "enter", ty);
    let ty = m.types.add(&[reference, ValType::I32], &[]);
    let (suspend, _) = m.add_import_func(HOOKS, "suspend", ty);
    let ty = m.types.add(&[reference], &[ValType::I32]);
    let (resume, _) = m.add_import_func(HOOKS, "resume", ty);
    let ty = m.types.add(&[reference], &[]);
    let (leave, _) = m.add_import_func(HOOKS, "leave", ty);
    for (import, original, name) in imports {
        if !suspended.is_empty() && !suspended.contains(&name) {
            continue;
        }
        let ty = m.funcs.get(original).ty();
        let (params, results) = {
            let t = m.types.get(ty);
            (t.params().to_vec(), t.results().to_vec())
        };
        let (external, _) = m.add_import_func("app", &name, ty);
        let args: Vec<_> = params.iter().map(|t| m.locals.add(*t)).collect();
        let result = results.first().map(|t| m.locals.add(*t));
        let context = m.locals.add(reference);
        let mut b = FunctionBuilder::new(&mut m.types, &params, &results);
        b.name(format!("stack_suspend_{name}"));
        let mut body = b.func_body();
        body.global_get(current).local_set(context);
        body.local_get(context).global_get(sp).call(suspend);
        body.ref_null(RefType::EXTERNREF).global_set(current);
        for arg in &args {
            body.local_get(*arg);
        }
        body.call(external);
        if let Some(result) = result {
            body.local_set(result);
        }
        // Restoration happens synchronously INSIDE Wasm after JSPI resumes.
        // No Promise reaction may run between restoring bytes and executing Rust.
        body.local_get(context).call(resume).global_set(sp);
        body.local_get(context).global_set(current);
        if let Some(result) = result {
            body.local_get(result);
        }
        let shim = b.finish(args, &mut m.funcs);
        let kind = core::mem::replace(
            &mut m.funcs.get_mut(shim).kind,
            FunctionKind::Uninitialized(ty),
        );
        m.funcs.get_mut(original).kind = kind;
        m.funcs.delete(shim);
        m.imports.delete(import);
    }
    for (export, original) in exports {
        let (params, results) = {
            let t = m.types.get(m.funcs.get(original).ty());
            (t.params().to_vec(), t.results().to_vec())
        };
        let args: Vec<_> = params.iter().map(|t| m.locals.add(*t)).collect();
        let result = results.first().map(|t| m.locals.add(*t));
        let context = m.locals.add(reference);
        let mut b = FunctionBuilder::new(&mut m.types, &params, &results);
        b.name(format!("stack_enter_{}", m.exports.get(export).name));
        let mut body = b.func_body();
        body.call(enter).local_tee(context).global_set(current);
        for arg in &args {
            body.local_get(*arg);
        }
        body.call(original);
        if let Some(result) = result {
            body.local_set(result);
        }
        body.local_get(context).call(leave);
        body.ref_null(RefType::EXTERNREF).global_set(current);
        if let Some(result) = result {
            body.local_get(result);
        }
        let shim = b.finish(args, &mut m.funcs);
        m.exports.get_mut(export).item = ExportItem::Function(shim);
    }
    walrus::passes::gc::run(&mut m);
    Ok(m.emit_wasm())
}
fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        return Err("usage: transform input.wasm output.wasm [suspending-import-name ...]".into());
    }
    fs::write(&args[1], instrument(&fs::read(&args[0])?, &args[2..])?)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use walrus::Module;
    fn fixture() -> Vec<u8> {
        wat::parse_str(
            r#"(module
          (import "app" "add" (func $add (param i32 i32) (result i32)))
          (memory (export "memory") 1 16)
          (global (export "__stack_pointer") (mut i32) (i32.const 65536))
          (global (export "__stack_low") i32 (i32.const 0))
          (global (export "__stack_high") i32 (i32.const 65536))
          (func (export "run") (param i32 i32) (result i32) local.get 0 local.get 1 call $add))"#,
        )
        .unwrap()
    }
    #[test]
    fn adds_synchronous_stack_hooks_and_preserves_application_api() {
        let result = instrument(&fixture(), &[]).unwrap();
        let m = Module::from_buffer(&result).unwrap();
        for name in ["enter", "suspend", "resume", "leave"] {
            assert!(m.imports.get_func("taraba:jspi-stack", name).is_ok());
        }
        assert!(m.exports.iter().any(|e| e.name == "run"));
    }
    #[test]
    fn rejects_missing_stack_contract_and_double_instrumentation() {
        assert!(instrument(&wat::parse_str("(module)").unwrap(), &[]).is_err());
        assert!(instrument(&instrument(&fixture(), &[]).unwrap(), &[]).is_err());
        assert!(instrument(&fixture(), &["missing".into()]).is_err());
    }
    #[test]
    fn rejects_reference_arguments_that_could_escape_a_borrow() {
        let bytes = wat::parse_str(
            r#"(module
          (import "app" "read" (func (param externref)))
          (memory (export "memory") 1)
          (global (export "__stack_pointer") (mut i32) (i32.const 65536))
          (global (export "__stack_low") i32 (i32.const 0))
          (global (export "__stack_high") i32 (i32.const 65536))
          (func (export "run")))"#,
        )
        .unwrap();
        assert!(instrument(&bytes, &[]).is_err());
    }
}
