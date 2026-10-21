//! Restricted JS Core profile. WIT is the contract; this is not Canonical ABI execution.
use crate::abi::{Abi, Bindings, Signature};
use std::{error::Error, path::Path};
use wit_parser::*;
type Result<T> = std::result::Result<T, Box<dyn Error>>;
const ABI: ManglingAndAbi = ManglingAndAbi::Legacy(LiftLowerAbi::Sync);

pub(crate) fn parse(path: &Path, world: Option<&str>) -> Result<Bindings> {
    let mut r = Resolve::default();
    let (pkg, _) = r.push_path(path)?;
    let world = r.select_world(&[pkg], world)?;
    let bindings = if crate::core_async::needed(&r, world) {
        crate::core_async::Contract::bindings(&r, world)?
    } else {
        convert(&r, world, true)?
    };
    if bindings
        .imports
        .keys()
        .any(|(module, _)| module.starts_with("taraba:helpers/") || module == "taraba:panic")
    {
        return Err("reserved private taraba import in application WIT".into());
    }
    Ok(bindings)
}
#[cfg(test)]
pub(crate) fn parse_text(text: &str) -> Result<Bindings> {
    parse_contract(text)
}
pub(crate) fn parse_contract(text: &str) -> Result<Bindings> {
    parse_inline(text, true)
}
pub(crate) fn parse_private_helpers(text: &str) -> Result<Bindings> {
    parse_inline(text, false)
}
fn parse_inline(text: &str, flatten_imports: bool) -> Result<Bindings> {
    let mut r = Resolve::default();
    let pkg = r.push_str("app.wit", text)?;
    let world = r.select_world(&[pkg], None)?;
    if flatten_imports && crate::core_async::needed(&r, world) {
        crate::core_async::Contract::bindings(&r, world)
    } else {
        convert(&r, world, flatten_imports)
    }
}
pub(crate) fn parse_wire(text: &str) -> Result<Bindings> {
    let mut r = Resolve::default();
    let package = r.push_str("wire.wit", text)?;
    let world = r.select_world(&[package], None)?;
    convert(&r, world, true)
}
fn value(r: &Resolve, ty: Type) -> Result<Abi> {
    Ok(match ty {
        Type::S32 => Abi::I32,
        Type::U32 => Abi::U32,
        Type::F64 => Abi::F64,
        Type::Id(id) => match r.types[id].kind {
            TypeDefKind::Type(t) => return value(r, t),
            TypeDefKind::Handle(Handle::Own(_)) | TypeDefKind::Resource => Abi::Own,
            TypeDefKind::Handle(Handle::Borrow(_)) => Abi::Borrow,
            _ => return Err("Core profile supports only s32, u32, f64 and imported resource handles".into()),
        },
        _ => return Err("unsupported WIT type in Core profile (use the Component backend experiment for canonical types)".into()),
    })
}
fn signature(r: &Resolve, f: &Function, export: bool) -> Result<Signature> {
    if !matches!(f.kind, FunctionKind::Freestanding) {
        return Err("Core profile requires synchronous freestanding WIT functions; select --component for native WIT async and Canonical ABI types".into());
    }
    let args = f
        .params
        .iter()
        .map(|p| value(r, p.ty))
        .collect::<Result<Vec<_>>>()?;
    let result = f.result.map(|t| value(r, t)).transpose()?;
    if matches!(result, Some(Abi::Borrow))
        || (export && args.iter().any(|v| matches!(v, Abi::Borrow)))
    {
        return Err("Core profile supports borrow only in import parameters".into());
    }
    Ok((args, result))
}
fn convert(r: &Resolve, world: WorldId, flatten_imports: bool) -> Result<Bindings> {
    let mut b = Bindings::default();
    let mut fields = std::collections::BTreeSet::new();
    for (export, items) in [
        (false, &r.worlds[world].imports),
        (true, &r.worlds[world].exports),
    ] {
        for (key, item) in items {
            let mut add = |interface: Option<&WorldKey>, f: &Function| -> Result<()> {
                let sig = signature(r, f, export)?;
                if export {
                    let name = r.wasm_export_name(
                        ABI,
                        WasmExport::Func {
                            interface,
                            func: f,
                            kind: WasmExportKind::Normal,
                        },
                    );
                    if name.starts_with("rt_") || name.starts_with("cabi_") {
                        return Err("WIT export overrides runtime ABI".into());
                    }
                    b.exports.insert(name, sig);
                } else {
                    let (module, field) =
                        r.wasm_import_name(ABI, WasmImport::Func { interface, func: f });
                    if module == "jsrt"
                        || module == "pool"
                        || (flatten_imports && !fields.insert(field.clone()))
                    {
                        return Err("reserved or duplicate Core application import".into());
                    }
                    b.imports.insert((module, field), sig);
                }
                Ok(())
            };
            match item {
                WorldItem::Function(f) => add(None, f)?,
                WorldItem::Interface { id, .. } => {
                    for f in r.interfaces[*id].functions.values() {
                        add(Some(key), f)?;
                    }
                    for ty in r.interfaces[*id].types.values() {
                        if matches!(r.types[*ty].kind, TypeDefKind::Resource) {
                            if export {
                                return Err("Core profile only supports imported resources".into());
                            }
                            b.drops.push(r.wasm_import_name(
                                ABI,
                                WasmImport::ResourceIntrinsic {
                                    interface: Some(key),
                                    resource: *ty,
                                    intrinsic: ResourceIntrinsic::ImportedDrop,
                                },
                            ));
                        }
                    }
                }
                WorldItem::Type { .. } => {}
            }
        }
    }
    Ok(b)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsupported_contracts_instead_of_silent_scalar_lowering() {
        for decl in ["export rt_poll: func();", "export cabi_hidden: func();"] {
            assert!(parse_text(&format!("package test:app; world app {{ {decl} }}")).is_err());
        }
        assert!(parse_text("package test:app; interface js { resource value; } world app { import js; use js.{value}; export x: func(v: borrow<value>); }").is_err());
    }
}
