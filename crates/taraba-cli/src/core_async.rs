//! Typed Rust facade for the private Core Promise ABI, not Canonical ABI.
use std::{error::Error, path::Path};
use wit_parser::*;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Clone, Copy, PartialEq)]
enum ValueType {
    I32,
    U32,
    F64,
    Value(usize),
}
impl ValueType {
    fn wit(self, types: &crate::core_types::Types) -> String {
        match self {
            Self::I32 => "s32".into(),
            Self::U32 => "u32".into(),
            Self::F64 => "f64".into(),
            Self::Value(t) => types.wit(t),
        }
    }
    fn wire(self) -> &'static str {
        match self {
            Self::I32 => "s32",
            Self::U32 => "u32",
            Self::F64 => "f64",
            Self::Value(_) => "value",
        }
    }
    fn rust(self, types: &crate::core_types::Types) -> String {
        match self {
            Self::I32 => "i32".into(),
            Self::U32 => "u32".into(),
            Self::F64 => "f64".into(),
            Self::Value(t) => types.rust_type(t),
        }
    }
    fn wire_rust(self) -> &'static str {
        match self {
            Self::I32 => "i32",
            Self::U32 => "u32",
            Self::F64 => "f64",
            Self::Value(_) => "__taraba_wire::Value",
        }
    }
    fn ts(self, types: &crate::core_types::Types) -> String {
        match self {
            Self::Value(t) => types.ts(t),
            _ => "number".into(),
        }
    }
}
struct Function {
    export: bool,
    name: String,
    args: Vec<(String, ValueType)>,
    result: Option<ValueType>,
    asynchronous: bool,
    public_args: Vec<crate::abi::PublicParameter>,
    public_result: String,
    public_wit_args: Vec<String>,
    public_wit_result: Option<String>,
}
pub(crate) struct Contract {
    wire: String,
    public: String,
    world: String,
    functions: Vec<Function>,
    types: crate::core_types::Types,
    members: std::collections::BTreeMap<String, crate::interfaces::Member>,
}
fn dealias(r: &Resolve, mut ty: Type) -> Type {
    while let Type::Id(id) = ty {
        match r.types[id].kind {
            TypeDefKind::Type(next) => ty = next,
            _ => break,
        }
    }
    ty
}
fn future(r: &Resolve, ty: Type) -> Option<Option<Type>> {
    match dealias(r, ty) {
        Type::Id(id) => match r.types[id].kind {
            TypeDefKind::Future(payload) => Some(payload),
            _ => None,
        },
        _ => None,
    }
}
fn value_type(
    r: &Resolve,
    ty: Type,
    types: &mut crate::core_types::Types,
    payload: bool,
) -> Result<ValueType> {
    match dealias(r, ty) {
        Type::S32 => Ok(ValueType::I32),
        Type::U32 if !payload => Ok(ValueType::U32),
        Type::F64 if !payload => Ok(ValueType::F64),
        _ => {
            let id = types.add(r, ty)?;
            types.use_codec(id);
            Ok(ValueType::Value(id))
        }
    }
}
pub(crate) fn rust_name(name: &str) -> Result<String> {
    // WIT identifiers contain ASCII words that are entirely lower/upper case.
    // This matches wit-bindgen's snake_case mapping without a runtime dependency.
    let name = name.replace('-', "_").to_ascii_lowercase();
    let escaped = format!("r#{name}");
    if syn::parse_str::<syn::Ident>(&escaped).is_err() {
        return Err(format!("unsupported Rust binding identifier: {name}").into());
    }
    Ok(
        if syn::parse_str::<syn::Ident>(&name).is_ok() && name != "gen" {
            name
        } else {
            escaped
        },
    )
}
pub(crate) fn needed(r: &Resolve, world: WorldId) -> bool {
    r.worlds[world]
        .imports
        .values()
        .chain(r.worlds[world].exports.values())
        .any(|item| {
            let WorldItem::Function(f) = item else {
                return matches!(item, WorldItem::Interface { id, .. } if !r.interfaces[*id].functions.is_empty());
            };
            matches!(f.kind, FunctionKind::AsyncFreestanding)
                || f.result.is_some_and(|t| future(r, t).is_some())
                || f.params
                    .iter()
                    .map(|p| p.ty)
                    .chain(f.result)
                    .any(|t| match dealias(r, t) {
                        Type::S32 | Type::U32 | Type::F64 => matches!(t, Type::Id(_)),
                        Type::Id(id)
                            if matches!(
                                r.types[id].kind,
                                TypeDefKind::Resource | TypeDefKind::Handle(_)
                            ) =>
                        {
                            false
                        }
                        _ => true,
                    })
        })
}
impl Contract {
    fn new(r: &Resolve, world: WorldId) -> Result<Self> {
        let guests = crate::core_resources::collect(r, world)?;
        let flat = crate::interfaces::flatten(r, world)?;
        let r = &flat.resolve;
        let w = &r.worlds[world];
        let mut functions = Vec::new();
        let mut types = crate::core_types::Types::default();
        types.guests = guests;
        let mut rust_names = std::collections::BTreeSet::new();
        for (export, items) in [(false, &w.imports), (true, &w.exports)] {
            for item in items.values() {
                let f = match item {
                    WorldItem::Function(f) => f,
                    WorldItem::Type {..} => continue,
                    _ => return Err("Core async bindings currently require world-level functions; use --component for interfaces/resources".into()),
                };
                if !matches!(
                    f.kind,
                    FunctionKind::Freestanding | FunctionKind::AsyncFreestanding
                ) {
                    return Err("unsupported Core async function kind".into());
                }
                if !rust_names.insert((export, rust_name(&f.name)?)) {
                    return Err(format!("Core Rust binding name collision: {}", f.name).into());
                }
                let payload = f.result.and_then(|ty| future(r, ty));
                if matches!(f.kind, FunctionKind::AsyncFreestanding) && payload.is_some() {
                    return Err(
                        "nested async/future results are not supported by Core async bindings"
                            .into(),
                    );
                }
                let asynchronous =
                    matches!(f.kind, FunctionKind::AsyncFreestanding) || payload.is_some();
                let result = payload
                    .unwrap_or(f.result)
                    .map(|ty| value_type(r, ty, &mut types, asynchronous))
                    .transpose()?;
                if result
                    .is_some_and(|t| matches!(t,ValueType::Value(id) if types.contains_borrow(id)))
                {
                    return Err("Core borrow resources are supported only as parameters".into());
                }
                let args = f
                    .params
                    .iter()
                    .map(|p| {
                        rust_name(&p.name)?;
                        Ok((p.name.clone(), value_type(r, p.ty, &mut types, false)?))
                    })
                    .collect::<Result<Vec<_>>>()?;
                if args.iter().any(|(_, ty)| matches!(ty, ValueType::Value(id) if types.contains_borrow(*id) && types.borrowed(*id).is_none())) {
                    return Err("Core borrow resources must be direct parameters; nested borrow handles are unsupported".into());
                }
                if !export
                    && (args.iter().any(
                        |(_, t)| matches!(t,ValueType::Value(id) if types.contains_guest(*id)),
                    ) || result.is_some_and(
                        |t| matches!(t,ValueType::Value(id) if types.contains_guest(id)),
                    ))
                {
                    return Err(
                        "Core Rust-owned resources cannot cross host imports yet; use --component"
                            .into(),
                    );
                }
                let public_args = f
                    .params
                    .iter()
                    .zip(&args)
                    .map(|(p, (_, ty))| {
                        let (ty, optional) = if matches!(p.ty, Type::Id(_)) {
                            let id = types.add(r, p.ty)?;
                            (types.ts(id), types.accepts_undefined(id))
                        } else {
                            (ty.ts(&types), false)
                        };
                        Ok(crate::abi::PublicParameter { ty, optional })
                    })
                    .collect::<Result<Vec<_>>>()?;
                let public_result = if let Some(source) = payload.unwrap_or(f.result) {
                    if matches!(source, Type::Id(_)) {
                        let id = types.add(r, source)?;
                        types.ts(id)
                    } else {
                        result.unwrap().ts(&types)
                    }
                } else {
                    "void".into()
                };
                let public_wit_args = f
                    .params
                    .iter()
                    .zip(&args)
                    .map(|(p, (_, ty))| {
                        if matches!(p.ty, Type::Id(_)) {
                            let id = types.add(r, p.ty)?;
                            Ok(types.wit(id))
                        } else {
                            Ok(ty.wit(&types))
                        }
                    })
                    .collect::<Result<Vec<_>>>()?;
                let public_wit_result = payload
                    .unwrap_or(f.result)
                    .map(|source| -> Result<String> {
                        if matches!(source, Type::Id(_)) {
                            let id = types.add(r, source)?;
                            Ok(types.wit(id))
                        } else {
                            Ok(result.unwrap().wit(&types))
                        }
                    })
                    .transpose()?;
                functions.push(Function {
                    export,
                    name: f.name.clone(),
                    args,
                    result,
                    asynchronous,
                    public_args,
                    public_result,
                    public_wit_args,
                    public_wit_result,
                });
            }
        }
        let package = w
            .package
            .map(|p| r.packages[p].name.to_string())
            .unwrap_or_else(|| "taraba:bindings".into());
        let mut wire = format!("package {package};\n");
        let mut public = format!("package {package};\nworld %{} {{\n", w.name);
        let asynchronous = functions.iter().any(|f| f.asynchronous);
        if asynchronous {
            wire.push_str("interface taraba-core { resource promise; }\n");
        }
        if types.has_codecs() && !asynchronous {
            wire.push_str("interface taraba-core { resource value; }\n");
        }
        if types.has_codecs() && asynchronous {
            wire = wire.replace("resource promise;", "resource promise; resource value;");
        }
        wire.push_str(&format!("world %{} {{\n", w.name));
        if asynchronous {
            wire.push_str("import taraba-core; use taraba-core.{promise};\n");
        }
        public.push_str(&types.declarations());
        if types.has_codecs() {
            if !asynchronous {
                wire.push_str("import taraba-core;\n");
            }
            wire.push_str("use taraba-core.{value};\n");
            wire.push_str(&types.generate()?.wire);
        }
        for f in &functions {
            let args = f
                .args
                .iter()
                .map(|(name, ty)| format!("%{name}:{}", ty.wire()))
                .collect::<Vec<_>>()
                .join(",");
            let result = if f.asynchronous {
                " -> promise".into()
            } else {
                f.result
                    .map(|ty| format!(" -> {}", ty.wire()))
                    .unwrap_or_default()
            };
            wire.push_str(&format!(
                "{} %{}: func({args}){result};\n",
                if f.export { "export" } else { "import" },
                f.name
            ));
            let args = f
                .args
                .iter()
                .zip(&f.public_wit_args)
                .map(|((name, _), ty)| format!("%{name}:{ty}"))
                .collect::<Vec<_>>()
                .join(",");
            let result = if f.asynchronous {
                format!(
                    " -> {}",
                    f.public_wit_result
                        .as_ref()
                        .map(|ty| format!("future<{ty}>"))
                        .unwrap_or_else(|| "future".into())
                )
            } else {
                f.public_wit_result
                    .as_ref()
                    .map(|ty| format!(" -> {ty}"))
                    .unwrap_or_default()
            };
            public.push_str(&format!(
                "{} %{}: func({args}){result};\n",
                if f.export { "export" } else { "import" },
                f.name
            ));
        }
        wire.push_str("}\n");
        public.push_str("}\n");
        if !flat.members.is_empty() || types.has_resources() {
            public = public_interfaces(&package, &w.name, &functions, &types, &flat.members)?;
        }
        Ok(Self {
            wire,
            public,
            world: w.name.clone(),
            functions,
            types,
            members: flat.members,
        })
    }
    pub(crate) fn bindings(r: &Resolve, world: WorldId) -> Result<crate::abi::Bindings> {
        let contract = Self::new(r, world)?;
        let mut bindings = crate::wit::parse_wire(&contract.wire)?;
        bindings.core_contract = Some(contract.public.clone());
        bindings.codecs = contract.types.generate()?.javascript;
        bindings.type_declarations = contract.types.typescript();
        bindings.interface_members = contract.members.clone();
        bindings.resource_types = contract.types.has_resources();
        for (id, info) in contract.types.guest_resources() {
            bindings.guest_resources.insert(
                contract.types.rust_type(id),
                crate::abi::GuestResourceBinding {
                    namespace: info.namespace.clone(),
                    name: info.name.clone(),
                    drop_export: format!("taraba-resource-drop-{id}"),
                    methods: std::collections::BTreeMap::new(),
                },
            );
        }
        for f in contract.functions.iter().filter(|f| f.export) {
            if let Some(m) = contract.members.get(&f.name).filter(|m| m.receiver) {
                let ValueType::Value(id) = f.args[0].1 else {
                    unreachable!()
                };
                let resource = contract
                    .types
                    .rust_type(contract.types.borrowed(id).unwrap());
                bindings
                    .guest_resources
                    .get_mut(&resource)
                    .ok_or("resource methods require a Rust-defined exported resource")?
                    .methods
                    .insert(m.method.clone(), f.name.clone());
            }
        }

        for f in contract.functions.iter().filter(|f| !f.export) {
            let args = f
                .args
                .iter()
                .enumerate()
                .map(|(i, (_, t))| match t {
                    ValueType::Value(t) => contract.types.host_js(*t, &format!("a{i}"), false),
                    _ => format!("a{i}"),
                })
                .collect::<Vec<_>>();
            let result = f.result.and_then(|t| match t {
                ValueType::Value(t) if contract.types.contains_resource(t) => {
                    Some(contract.types.host_js(t, "value", true))
                }
                _ => None,
            });
            if result.is_some() || args.iter().enumerate().any(|(i, a)| a != &format!("a{i}")) {
                bindings
                    .host_marshalling
                    .insert(f.name.clone(), (args, result, f.asynchronous));
            }
        }
        for f in &contract.functions {
            if f.asynchronous {
                let signature = if f.export {
                    bindings.exports.get_mut(&f.name)
                } else {
                    bindings.imports.get_mut(&("$root".into(), f.name.clone()))
                }
                .ok_or("generated Core binding name mismatch")?;
                signature.1 = Some(match f.result {
                    Some(ValueType::I32) => crate::abi::Abi::FutureI32,
                    Some(_) => crate::abi::Abi::FutureValue,
                    None => crate::abi::Abi::FutureVoid,
                });
            }
            let signature = crate::abi::PublicSignature {
                args: f.public_args.clone(),
                result: f.public_result.clone(),
                asynchronous: f.asynchronous,
            };
            if !f.export {
                if let Some(m) = contract.members.get(&f.name).filter(|m| m.receiver) {
                    let ValueType::Value(t) = f.args[0].1 else {
                        unreachable!()
                    };
                    let resource = contract
                        .types
                        .rust_type(contract.types.borrowed(t).unwrap());
                    bindings
                        .resource_methods
                        .entry(resource)
                        .or_default()
                        .insert(
                            m.method.clone(),
                            crate::abi::PublicSignature {
                                args: signature.args[1..].to_vec(),
                                result: signature.result.clone(),
                                asynchronous: signature.asynchronous,
                            },
                        );
                }
            }
            if f.export {
                bindings.public_exports.insert(f.name.clone(), signature);
            } else {
                bindings.public_imports.insert(f.name.clone(), signature);
            }
        }
        Ok(bindings)
    }
    fn rust(&self) -> Result<String> {
        let helper = include_str!("templates/map_future.rs");
        let mut rust = format!(
            "// Generated from WIT. Do not edit. Private Core ABI, not Canonical ABI.\nmacro_rules! bindings {{ () => {{\n#[allow(dead_code, unsafe_code)]\nmod __taraba_wire {{ ::wit_bindgen::generate!({{ path: [], inline: {:?}, world: {:?}, export_macro_name: \"__taraba_export\" }}); }}\n#[allow(dead_code, unsafe_code)]\nmod __taraba_future {{ {helper} }}\npub type HostResult<T> = ::core::result::Result<T, ::taraba::JsValue>;\n#[allow(async_fn_in_trait)]\npub trait Guest {{\n",
            self.wire, self.world
        );
        if self.types.has_guests() {
            rust = rust.replacen("bindings { () => {", "bindings { ($guest:ty) => {", 1);
        }
        for f in self
            .functions
            .iter()
            .filter(|f| f.export && !self.members.contains_key(&f.name))
        {
            let args = f.rust_args(&self.types)?;
            let result = f.rust_result(&self.types);
            rust.push_str(&format!(
                "{}fn {}({args}) -> {result};\n",
                if f.asynchronous { "async " } else { "" },
                rust_name(&f.name)?
            ));
        }
        rust.push_str("}\n");
        rust.push_str(&self.types.generate()?.rust);
        let mut export_modules = std::collections::BTreeMap::<String, String>::new();
        let mut resource_traits =
            std::collections::BTreeMap::<String, std::collections::BTreeMap<String, String>>::new();
        for (_, info) in self.types.guest_resources() {
            export_modules
                .entry(info.namespace.clone())
                .or_default()
                .push_str(&format!(
                    "type {}:{}+'static;",
                    crate::core_resources::pascal(&info.name),
                    info.trait_name()
                ));
            resource_traits
                .entry(info.namespace.clone())
                .or_default()
                .entry(info.name.clone())
                .or_default();
        }
        for f in self.functions.iter().filter(|f| f.export) {
            if let Some(m) = self.members.get(&f.name) {
                let line = if m.receiver || m.constructor {
                    let id = if m.receiver {
                        let ValueType::Value(id) = f.args[0].1 else {
                            unreachable!()
                        };
                        id
                    } else {
                        let Some(ValueType::Value(id)) = f.result else {
                            unreachable!()
                        };
                        id
                    };
                    let info = self
                        .types
                        .guest(id)
                        .ok_or("exported resource method requires Rust-owned type")?;
                    let args = f.rust_args(&self.types)?;
                    let args = if m.receiver {
                        format!(
                            "&self{}",
                            args.split_once(',')
                                .map(|(_, tail)| format!(",{tail}"))
                                .unwrap_or_default()
                        )
                    } else {
                        args
                    };
                    let result = if m.constructor {
                        "Self".into()
                    } else {
                        f.rust_result(&self.types)
                    };
                    resource_traits
                        .get_mut(&info.namespace)
                        .unwrap()
                        .get_mut(&info.name)
                        .unwrap()
                        .push_str(&format!(
                            "{}fn {}({args})->{result};",
                            if f.asynchronous { "async " } else { "" },
                            if m.constructor {
                                "new".into()
                            } else {
                                rust_name(&m.method)?
                            }
                        ));
                    continue;
                } else {
                    format!(
                        "{}fn {}({})->{};",
                        if f.asynchronous { "async " } else { "" },
                        rust_name(&m.method)?,
                        f.rust_args(&self.types)?,
                        f.rust_result(&self.types)
                    )
                };
                export_modules
                    .entry(m.namespace.clone())
                    .or_default()
                    .push_str(&line);
            }
        }
        if !export_modules.is_empty() {
            rust.push_str("pub mod exports {\n");
            for (namespace, body) in export_modules {
                rust.push_str(&format!("pub mod {} {{use super::super::*; #[allow(async_fn_in_trait)] pub trait Guest {{{body}}}\n",crate::interfaces::rust_namespace(&namespace)?));
                if let Some(traits) = resource_traits.get(&namespace) {
                    for (name, body) in traits {
                        rust.push_str(&format!("#[allow(async_fn_in_trait)] pub trait Guest{}:Sized+'static {{{body}}}\n",crate::core_resources::pascal(name)));
                    }
                }
                rust.push_str("}\n");
            }
            rust.push_str("}\n");
        }
        let mut import_modules = std::collections::BTreeMap::<String, String>::new();
        for f in self.functions.iter().filter(|f| !f.export) {
            let start = rust.len();
            let args = f.rust_args(&self.types)?;
            let values = f.encoded_values()?;
            let name = rust_name(&f.name)?;
            rust.push_str(&format!(
                "#[inline]\npub {}fn {name}({args}) -> {} {{\n",
                if f.asynchronous { "async " } else { "" },
                f.rust_result(&self.types)
            ));
            if f.asynchronous {
                rust.push_str(&format!("// The generated resource transfers exactly one root from this instance.\nlet p = unsafe {{ ::taraba::JsPromise::from_abi(__taraba_wire::{name}({values}).take_handle()) }};\nlet value = ::core::future::IntoFuture::into_future(p).await?;\n"));
                match f.result {
                    Some(ValueType::I32)=>rust.push_str("value.as_i32().map_err(|e| ::taraba::JsValue::from_i32(e.0))\n"),
                    Some(ValueType::Value(t))=>rust.push_str(&format!("// Ownership moves from JsValue into the wire resource; its Drop releases the root.\nlet value=unsafe {{__taraba_wire::Value::from_handle(value.into_abi())}}; Ok(__taraba_types::decode_{t}(&value))\n")),
                    None=>rust.push_str("drop(value); Ok(())\n"),_=>unreachable!(),
                }
            } else {
                match f.result {
                    Some(ValueType::Value(t)) => rust.push_str(&format!(
                        "__taraba_types::decode_{t}(&__taraba_wire::{name}({values}))\n"
                    )),
                    _ => rust.push_str(&format!("__taraba_wire::{name}({values})\n")),
                }
            }
            rust.push_str("}\n");
            if let Some(m) = self.members.get(&f.name) {
                let body = rust.split_off(start).replacen(
                    &format!("fn {name}("),
                    &format!(
                        "fn {}(",
                        rust_name(&if m.receiver {
                            format!("{}_{}", m.resource.as_ref().unwrap(), m.method)
                        } else {
                            m.method.clone()
                        })?
                    ),
                    1,
                );
                import_modules
                    .entry(m.namespace.clone())
                    .or_default()
                    .push_str(&body);
            }
        }
        if !import_modules.is_empty() {
            rust.push_str("pub mod imports {\n");
            for (namespace, body) in import_modules {
                rust.push_str(&format!(
                    "pub mod {} {{use super::super::*; {body} }}\n",
                    crate::interfaces::rust_namespace(&namespace)?
                ));
            }
            rust.push_str("}\n");
        }
        let mut methods = std::collections::BTreeSet::new();
        for f in self.functions.iter().filter(|f| !f.export) {
            if let Some(m) = self.members.get(&f.name).filter(|m| m.receiver) {
                let ValueType::Value(t) = f.args[0].1 else {
                    unreachable!()
                };
                let resource = self.types.rust_type(self.types.borrowed(t).unwrap());
                if !methods.insert((resource.clone(), m.method.clone())) {
                    continue;
                }
                let args = f.rust_args(&self.types)?;
                let tail = args
                    .split_once(',')
                    .map(|(_, tail)| format!(",{tail}"))
                    .unwrap_or_default();
                let values = f
                    .args
                    .iter()
                    .skip(1)
                    .map(|(n, _)| rust_name(n))
                    .collect::<Result<Vec<_>>>()?
                    .join(",");
                rust.push_str(&format!("impl {resource} {{pub {}fn {}(&self{tail})->{} {{imports::{}::{}(self{}{}){} }} }}\n",if f.asynchronous {"async "}else{""},rust_name(&m.method)?,f.rust_result(&self.types),crate::interfaces::rust_namespace(&m.namespace)?,rust_name(&format!("{}_{}",m.resource.as_ref().unwrap(),m.method))?,if values.is_empty(){""}else{","},values,if f.asynchronous{".await"}else{""}));
            }
        }
        // Expand at the application's call site, like wit-bindgen. Besides
        // useful diagnostics, this avoids embedding OUT_DIR's long absolute
        // filename in std's async-resumed-after-completion panic locations.
        rust.push_str("}; }\n#[allow(unused_imports)]\npub(crate) use bindings;\nmacro_rules! export { ($component:ty) => {\n");
        rust.push_str(&format!("const _: () = {{ #[allow(dead_code)] #[unsafe(link_section = \"taraba:core-wit\")] pub static CONTRACT: [u8; {}] = {:?}; }};\n", self.public.len(),self.public.as_bytes()));
        if self.functions.iter().any(|f| f.asynchronous) {
            rust.push_str("::taraba::export_runtime!();\n");
        }
        rust.push_str("const _: () = { struct __TarabaAdapter; impl __taraba_wire::Guest for __TarabaAdapter {\n");
        for f in self.functions.iter().filter(|f| f.export) {
            let name = rust_name(&f.name)?;
            let args = f.wire_args()?;
            let values = f.decoded_values()?;
            let (guest, method) = if let Some(m) = self.members.get(&f.name) {
                (
                    format!(
                        "exports::{}::Guest",
                        crate::interfaces::rust_namespace(&m.namespace)?
                    ),
                    rust_name(&m.method)?,
                )
            } else {
                ("Guest".into(), name.clone())
            };
            let result = if f.asynchronous {
                "__taraba_wire::Promise"
            } else {
                f.result.map(ValueType::wire_rust).unwrap_or("()")
            };
            rust.push_str(&format!("fn {name}({args}) -> {result} {{\n"));
            let member = self.members.get(&f.name);
            let resource_member = member.filter(|m| m.constructor || m.receiver);
            let mut invocation = format!("<$component as {guest}>::{method}({values})");
            if let Some(m) = resource_member {
                let id = if m.receiver {
                    let ValueType::Value(id) = f.args[0].1 else {
                        unreachable!()
                    };
                    id
                } else {
                    let Some(ValueType::Value(id)) = f.result else {
                        unreachable!()
                    };
                    id
                };
                let info = self.types.guest(id).unwrap();
                let provider = format!(
                    "<$component as exports::{}::Guest>::{}",
                    crate::interfaces::rust_namespace(&info.namespace)?,
                    crate::core_resources::pascal(&info.name)
                );
                let resource_trait = format!(
                    "exports::{}::{}",
                    crate::interfaces::rust_namespace(&info.namespace)?,
                    info.trait_name()
                );
                if m.constructor {
                    invocation = format!(
                        "{}::new(<{provider} as {resource_trait}>::new({values}))",
                        self.types.rust_type(id)
                    );
                } else {
                    for (arg, ty) in &f.args {
                        let arg = rust_name(arg)?;
                        let decoded = match ty {
                            ValueType::Value(t) => format!("__taraba_types::decode_{t}(&{arg})"),
                            _ => arg.clone(),
                        };
                        rust.push_str(&format!("let {arg}={decoded};"));
                    }
                    let receiver = rust_name(&f.args[0].0)?;
                    let rest = f
                        .args
                        .iter()
                        .skip(1)
                        .map(|(n, _)| rust_name(n))
                        .collect::<Result<Vec<_>>>()?
                        .join(",");
                    invocation = format!(
                        "<{provider} as {resource_trait}>::{method}(&**{receiver}{}{rest})",
                        if rest.is_empty() { "" } else { "," }
                    );
                    if f.asynchronous {
                        invocation = format!("async move {{{invocation}.await}}");
                    }
                }
            }
            if f.asynchronous {
                let encode = match f.result {
                    Some(ValueType::I32) => "::taraba::JsValue::from_i32".into(),
                    Some(ValueType::Value(t)) => format!(
                        "|value| unsafe {{ ::taraba::JsValue::from_abi(__taraba_types::encode_{t}(value).take_handle()) }}"
                    ),
                    None => "|()| ::taraba::JsValue::undefined()".into(),
                    _ => unreachable!(),
                };
                rust.push_str(&format!("let future = {invocation};\nlet p = ::taraba::future_to_promise(__taraba_future::map_future(future, |result| result.map({encode})));\n// One live root moves into the generated resource and then to JavaScript.\nunsafe {{ __taraba_wire::Promise::from_handle(p.into_abi()) }}\n"));
            } else {
                match f.result {
                    Some(ValueType::Value(t)) => {
                        rust.push_str(&format!("__taraba_types::encode_{t}({invocation})\n"))
                    }
                    _ => rust.push_str(&format!("{invocation}\n")),
                }
            }
            rust.push_str("}\n");
        }
        for (id, _) in self.types.guest_resources() {
            rust.push_str(&format!("fn taraba_resource_drop_{id}(key:u32){{drop(__taraba_types::STORE_{id}.take(key));}}\n"));
        }
        rust.push_str("}\n__taraba_wire::__taraba_export!(__TarabaAdapter with_types_in self::__taraba_wire);\n}; }; }\n#[allow(unused_imports)]\npub(crate) use export;\n");
        Ok(rust)
    }
}
fn public_interfaces(
    package: &str,
    world: &str,
    functions: &[Function],
    types: &crate::core_types::Types,
    members: &std::collections::BTreeMap<String, crate::interfaces::Member>,
) -> Result<String> {
    let declarations = types.declarations();
    // All named types live in one shared interface; its use aliases collapse
    // during normalization so codec IDs and fingerprints remain stable.
    let names = types.wit_names().join(",");
    let uses = if names.is_empty() {
        String::new()
    } else {
        format!("use taraba-values.{{{names}}};\n")
    };
    let mut output = format!("package {package};\ninterface taraba-values {{{declarations}}}\n");
    let mut definitions = std::collections::BTreeMap::<String, String>::new();
    let mut items = String::new();
    let mut emitted = std::collections::BTreeSet::new();
    for f in functions {
        let member = members.get(&f.name);
        // Keep constructor identity in the private fingerprint without defining
        // the resource twice. The original public WIT is packaged unchanged.
        let name = member
            .map(|m| {
                if m.receiver {
                    format!(
                        "taraba-method-{}-{}",
                        m.resource
                            .as_ref()
                            .unwrap()
                            .bytes()
                            .map(|b| format!("{b:02x}"))
                            .collect::<String>(),
                        m.method
                    )
                } else if m.constructor {
                    format!("taraba-constructor-{}", m.method)
                } else {
                    m.method.clone()
                }
            })
            .unwrap_or_else(|| f.name.clone());
        let args = f
            .args
            .iter()
            .zip(&f.public_wit_args)
            .map(|((n, _), ty)| format!("%{n}:{ty}"))
            .collect::<Vec<_>>()
            .join(",");
        let result = if f.asynchronous {
            format!(
                " -> {}",
                f.public_wit_result
                    .as_ref()
                    .map(|t| format!("future<{t}>"))
                    .unwrap_or_else(|| "future".into())
            )
        } else {
            f.public_wit_result
                .as_ref()
                .map(|t| format!(" -> {t}"))
                .unwrap_or_default()
        };
        let function = format!("%{name}: func({args}){result};\n");
        if let Some(m) = member {
            let body = definitions.entry(m.identity.clone()).or_default();
            if !body.contains(&function) {
                body.push_str(&function);
            }
            if emitted.insert((f.export, m.namespace.clone())) {
                items.push_str(&format!(
                    "{} %{}: %{};\n",
                    if f.export { "export" } else { "import" },
                    m.namespace,
                    m.identity
                ));
            }
        } else {
            items.push_str(&format!(
                "{} {function}",
                if f.export { "export" } else { "import" }
            ));
        }
    }
    for (name, body) in definitions {
        output.push_str(&format!("interface %{name} {{{uses}{body}}}\n"));
    }
    if types.has_guests() {
        output.push_str(&format!("interface taraba-guest-resources {{{uses}"));
        for (id, info) in types.guest_resources() {
            output.push_str(&format!(
                "guest-{}-{}:func(value:borrow<{}>);",
                crate::core_resources::hex(&info.namespace),
                crate::core_resources::hex(&info.name),
                types.wit(id)
            ));
        }
        output.push_str("}\n");
        items.push_str("export taraba-guest-resources;\n");
    }
    output.push_str(&format!(
        "world %{world} {{{resource_import}{uses}{items}}}\n",
        resource_import = if types.has_resources() {
            "import taraba-values;\n"
        } else {
            ""
        }
    ));
    Ok(output)
}

impl Function {
    fn rust_args(&self, types: &crate::core_types::Types) -> Result<String> {
        Ok(self
            .args
            .iter()
            .map(|(name, ty)| {
                Ok(format!(
                    "{}: {}",
                    rust_name(name)?,
                    if !self.export {
                        match ty {
                            ValueType::Value(t) if types.borrowed(*t).is_some() => {
                                format!("&{}", types.rust_type(types.borrowed(*t).unwrap()))
                            }
                            _ => ty.rust(types),
                        }
                    } else {
                        ty.rust(types)
                    }
                ))
            })
            .collect::<Result<Vec<_>>>()?
            .join(", "))
    }
    fn wire_args(&self) -> Result<String> {
        Ok(self
            .args
            .iter()
            .map(|(name, ty)| Ok(format!("{}:{}", rust_name(name)?, ty.wire_rust())))
            .collect::<Result<Vec<_>>>()?
            .join(","))
    }
    fn encoded_values(&self) -> Result<String> {
        Ok(self
            .args
            .iter()
            .map(|(name, ty)| {
                let name = rust_name(name)?;
                Ok(match ty {
                    ValueType::Value(t) => format!("__taraba_types::encode_{t}({name})"),
                    _ => name,
                })
            })
            .collect::<Result<Vec<_>>>()?
            .join(","))
    }
    fn decoded_values(&self) -> Result<String> {
        Ok(self
            .args
            .iter()
            .map(|(name, ty)| {
                let name = rust_name(name)?;
                Ok(match ty {
                    ValueType::Value(t) => format!("__taraba_types::decode_{t}(&{name})"),
                    _ => name,
                })
            })
            .collect::<Result<Vec<_>>>()?
            .join(","))
    }
    fn rust_result(&self, types: &crate::core_types::Types) -> String {
        let scalar = self
            .result
            .map(|t| t.rust(types))
            .unwrap_or_else(|| "()".into());
        if self.asynchronous {
            format!("HostResult<{scalar}>")
        } else {
            scalar.into()
        }
    }
}

/// Generate the safe Rust facade at Cargo build time. No executor is added.
pub fn generate_core_bindings(path: &Path, world: Option<&str>, output: &Path) -> Result<()> {
    let mut r = Resolve::default();
    let (package, _) = r.push_path(path)?;
    let world = r.select_world(&[package], world)?;
    let source = Contract::new(&r, world)?.rust()?;
    syn::parse_file(&source)?;
    std::fs::create_dir_all(output)?;
    std::fs::write(output.join("bindings.rs"), source)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_resource_metadata_and_receiver_methods_round_trip() {
        let b = crate::wit::parse_text("package test:guest; interface counters {resource counter {constructor(start:u32);read:func()->u32;wait:async func()->u32;} consume:func(v:own<counter>)->u32;} world app {export api:counters;}").unwrap();
        let round_trip = crate::wit::parse_contract(b.core_contract.as_ref().unwrap()).unwrap();
        assert!(b == round_trip);
        assert_eq!(b.guest_resources.len(), 1);
        assert_eq!(b.guest_resources.values().next().unwrap().methods.len(), 2);
        let (_, ts) =
            crate::bindings::generate(&b, false, crate::helpers::Features::default()).unwrap();
        assert!(ts.contains("Promise<CountersCounter>"));
        assert!(ts.contains("\"read\"("));
    }
    #[test]
    fn unsupported_resource_contracts_fail_before_rust_compilation() {
        for (text, diagnostic) in [
            (
                "package test:resource-static; interface counters {resource counter {make:static func()->own<counter>;}} world app {export api:counters;}",
                "static methods",
            ),
            (
                "package test:aliases; interface counters {resource counter {constructor();}} world app {export a:counters;export b:counters;}",
                "one export alias",
            ),
            (
                "package test:thenable; interface counters {resource counter {then:func();}} world app {export api:counters;}",
                "thenable",
            ),
            (
                "package test:crossing; interface counters {resource counter {constructor();}} world app {use counters.{counter};import take:func(v:own<counter>);export api:counters;}",
                "cannot cross host imports",
            ),
        ] {
            let error = crate::wit::parse_text(text)
                .err()
                .expect("unsupported resource must fail")
                .to_string();
            assert!(error.contains(diagnostic), "{error}");
        }
    }

    #[test]
    fn string_decoder_relies_on_the_generated_text_encoder() {
        let mut resolve = Resolve::default();
        let p = resolve
            .push_str(
                "app.wit",
                "package test:text; world app {export run:async func(v:string)->string;}",
            )
            .unwrap();
        let world = resolve.select_world(&[p], None).unwrap();
        let contract = Contract::new(&resolve, world).unwrap();
        let rust = contract.rust().unwrap();
        assert!(rust.contains("String::from_utf8_unchecked(bytes)"));
        assert!(!rust.contains("String::from_utf8(bytes)"));
        assert!(
            contract
                .types
                .generate()
                .unwrap()
                .javascript
                .values()
                .any(|v| v.contains("encoder.encodeInto"))
        );
    }

    #[test]
    fn synchronous_scalar_interfaces_select_the_typed_facade() {
        let text = "package test:scalar; interface api { run:func(v:u32)->u32; } world app { export api; }";
        let b = crate::wit::parse_text(text).unwrap();
        assert_eq!(b.interface_members.len(), 1);
    }

    #[test]
    fn nested_borrows_fail_with_an_explicit_diagnostic() {
        let text = "package test:leases; interface handles {resource value;} world app {import handles; use handles.{value}; record input {v:borrow<value>} export run:async func(v:input);}";
        let error = crate::wit::parse_text(text)
            .err()
            .expect("nested borrow must fail")
            .to_string();
        assert!(error.contains("direct parameters"), "{error}");
    }

    #[test]
    fn rich_core_types_are_typed_and_generated_only_when_reachable() {
        let text = r#"package test:rich;
        world app {
            record message { text: string, ids: list<u64>, enabled: bool }
            variant answer { accepted(message), rejected(string), pending }
            type response = result<option<answer>, string>;
            record unused { hidden: list<char> }
            import exchange: func(value: message) -> future<response>;
            export run: async func(value: message) -> response;
        }"#;
        let b = crate::wit::parse_text(text).unwrap();
        let (js, ts) =
            crate::bindings::generate(&b, false, crate::helpers::Features::default()).unwrap();
        assert!(ts.contains("bigint"));
        assert!(ts.contains("boolean"));
        assert!(ts.contains("PromiseLike<"));
        assert!(ts.contains("accepted"));
        assert!(!ts.contains("Promise<unknown>"));
        assert!(
            !js.contains("fromCodePoint"),
            "unused char codec must not be generated"
        );
        assert!(!ts.contains("hidden"));
        let mut r = Resolve::default();
        let p = r.push_str("app.wit", text).unwrap();
        let world = r.select_world(&[p], None).unwrap();
        let source = Contract::new(&r, world).unwrap().rust().unwrap();
        syn::parse_file(&source).unwrap();
        assert!(source.contains("pub struct Message"));
        assert!(source.contains("pub enum Answer"));
        assert!(!source.contains("struct Unused"));
    }

    #[test]
    fn typescript_exports_names_and_accepts_readonly_typed_data() {
        let b = crate::wit::parse_text(
            r#"package test:ts; world app {
          record request { data:list<u8>, samples:list<f32> }
          variant response { accepted(request), failed(string) }
          export send: async func(value:request)->response;
        }"#,
        )
        .unwrap();
        let (_, ts) =
            crate::bindings::generate(&b, false, crate::helpers::Features::default()).unwrap();
        assert!(ts.contains("export type Request ="));
        assert!(ts.contains("export type Response ="));
        assert!(ts.contains("Uint8Array"));
        assert!(ts.contains("Float32Array"));
        assert!(ts.contains("WitInput<Request>"));
        assert!(ts.contains("Promise<Response>"));
        assert!(!ts.contains("TarabaType"));
    }

    #[test]
    fn typescript_optional_fields_and_nested_options_preserve_information() {
        let b = crate::wit::parse_text(
            r#"package test:options; world app {
          type nickname = option<string>;
          record user { name:string, nickname:nickname }
          type nested = option<option<bool>>;
          export find:async func(value:user)->nested;
        }"#,
        )
        .unwrap();
        let (js, ts) =
            crate::bindings::generate(&b, false, crate::helpers::Features::default()).unwrap();
        assert!(ts.contains("export type Nickname = (string | undefined)"));
        assert!(ts.contains("\"nickname\"?: Nickname"));
        assert!(ts.contains("export type Nested ="));
        assert!(ts.contains("\"some\""));
        assert!(js.contains("v===undefined"));
    }

    #[test]
    fn scalar_alias_exports_types_without_emitting_value_codecs() {
        let b=crate::wit::parse_text("package test:ids; world app {type user-id=u32; export identity:func(v:user-id)->user-id;}").unwrap();
        let (js, ts) =
            crate::bindings::generate(&b, true, crate::helpers::Features::default()).unwrap();
        assert!(ts.contains("export type UserId = number"));
        assert!(b.codecs.is_empty());
        assert!(!b.uses_resource_handles());
        assert!(!js.contains("memory"));
    }

    #[test]
    fn typescript_builtin_collisions_fail_before_building_the_guest() {
        for name in ["array", "promise", "uint8-array", "wit-input", "app-host"] {
            let result = crate::wit::parse_text(&format!(
                "package test:names; world app {{record {name} {{v:bool}} export run:async func(v:{name})->{name};}}"
            ));
            assert!(result.is_err(), "{name} must not shadow a generated type");
        }
        let b=crate::wit::parse_text("package test:names; world app {record taraba-type-input {v:bool} export run:async func(v:taraba-type-input)->taraba-type-input;}").unwrap();
        assert!(
            b.type_declarations
                .contains("export type TarabaTypeInput =")
        );
    }

    #[test]
    fn contract_distinguishes_same_js_type_with_different_wit_semantics() {
        let parse = |ty| {
            crate::wit::parse_text(&format!(
                "package test:exact; world app {{export run:func()->future<{ty}>;}}"
            ))
            .unwrap()
        };
        for (a, b) in [("u8", "u16"), ("u32", "f64"), ("s64", "u64")] {
            assert!(
                parse(a) != parse(b),
                "{a} and {b} must not share a contract"
            );
        }
    }

    #[test]
    fn future_and_async_functions_generate_the_same_typed_facade() {
        let mut outputs = Vec::new();
        for declaration in [
            "func(a:s32,b:s32)->future<s32>",
            "async func(a:s32,b:s32)->s32",
        ] {
            let mut r = Resolve::default();
            let package = r.push_str("app.wit", &format!("package test:app; world app {{ import add:{declaration}; export run:{declaration}; }}")).unwrap();
            let world = r.select_world(&[package], None).unwrap();
            let contract = Contract::new(&r, world).unwrap();
            let rust = contract.rust().unwrap();
            assert!(rust.contains("pub async fn add"));
            assert!(rust.contains("async fn run"));
            assert!(rust.contains("HostResult<i32>"));
            assert!(contract.wire.contains("resource promise"));
            assert!(!contract.wire.contains("future<"));
            syn::parse_file(&rust).unwrap();
            outputs.push(rust);
        }
        assert_eq!(outputs[0], outputs[1]);
    }

    #[test]
    fn typed_future_preserves_payload_in_typescript_and_rejects_unsupported_payloads() {
        use crate::{abi::Abi, helpers::Features};
        for result in ["future<s32>", "future"] {
            let text = format!(
                "package test:typed; world app {{ import wait:func()->{result}; export run:func()->{result}; }}"
            );
            let b = crate::wit::parse_text(&text).unwrap();
            assert!(b.uses_resource_handles());
            let (_, ts) = crate::bindings::generate(&b, false, Features::default()).unwrap();
            if result == "future<s32>" {
                assert!(matches!(b.exports["run"].1, Some(Abi::FutureI32)));
                assert!(ts.contains("PromiseLike<number>"));
                assert!(ts.contains("Promise<number>"));
            } else {
                assert!(matches!(b.exports["run"].1, Some(Abi::FutureVoid)));
                assert!(ts.contains("Promise<void>"));
            }
            assert!(!ts.contains("Promise<unknown>"));
        }
        for result in ["future<future<s32>>"] {
            assert!(
                crate::wit::parse_text(&format!(
                    "package test:bad; world app {{ export run:func()->{result}; }}"
                ))
                .is_err()
            );
        }
        let b=crate::wit::parse_text("package test:old; interface js {resource promise;} world app {import js; use js.{promise}; export run:func()->promise;}").unwrap();
        let (_, ts) = crate::bindings::generate(&b, false, Features::default()).unwrap();
        assert!(ts.contains("Promise<unknown>"));
    }
}

#[cfg(test)]
mod future_map {
    include!("templates/map_future.rs");
    include!("map_future_tests.rs");
}
