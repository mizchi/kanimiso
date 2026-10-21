//! Reachable, application-specific value codecs. No codec lives in the shared runtime.
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
};
use wit_parser::*;
type Result<T> = std::result::Result<T, Box<dyn Error>>;
#[derive(Clone)]
enum Kind {
    Primitive(Type),
    Resource,
    Own(usize),
    Borrow(usize),
    List(usize),
    Option(usize),
    Result(Option<usize>, Option<usize>),
    Tuple(Vec<usize>),
    Record(Vec<(String, usize)>),
    Variant(Vec<(String, Option<usize>)>),
    Enum(Vec<String>),
    Flags(Vec<String>),
    Alias(usize),
}
struct Node {
    source: Type,
    name: Option<String>,
    kind: Kind,
}
#[derive(Default)]
pub(crate) struct Types {
    nodes: Vec<Node>,
    codecs: BTreeSet<usize>,
}
pub(crate) struct Generated {
    pub wire: String,
    pub javascript: BTreeMap<String, String>,
    pub rust: String,
}
fn pascal(name: &str) -> String {
    name.split('-')
        .map(|part| {
            let mut c = part.chars();
            c.next().unwrap().to_uppercase().collect::<String>() + &c.as_str().to_ascii_lowercase()
        })
        .collect()
}
fn json(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}
fn rust_ident(s: &str) -> Result<String> {
    super::core_async::rust_name(s)
}
impl Types {
    pub fn wit_names(&self) -> Vec<String> {
        self.nodes
            .iter()
            .enumerate()
            .filter_map(|(id, n)| {
                // Anonymous containers still have private WIT declarations and
                // must be imported by interfaces that reference their names.
                (!matches!(n.kind, Kind::Primitive(_) | Kind::Own(_) | Kind::Borrow(_)))
                    .then(|| self.wit_name(id))
            })
            .collect()
    }
    pub fn add(&mut self, r: &Resolve, source: Type) -> Result<usize> {
        if let Type::Id(id) = source {
            if let TypeDefKind::Type(Type::Id(target)) = r.types[id].kind {
                if r.types[id].name == r.types[target].name {
                    return self.add(r, Type::Id(target));
                }
            }
        }
        if let Some(id) = self.nodes.iter().position(|n| n.source == source) {
            return Ok(id);
        }
        let mut name = None;
        let kind = if let Type::Id(id) = source {
            name = r.types[id].name.clone();
            match &r.types[id].kind {
                TypeDefKind::Resource => Kind::Resource,
                TypeDefKind::Handle(Handle::Own(t))=>Kind::Own(self.add(r,Type::Id(*t))?),
                TypeDefKind::Handle(Handle::Borrow(t))=>Kind::Borrow(self.add(r,Type::Id(*t))?),
                TypeDefKind::Type(t) => Kind::Alias(self.add(r, *t)?),
                TypeDefKind::List(t) => Kind::List(self.add(r, *t)?),
                TypeDefKind::Option(t) => Kind::Option(self.add(r, *t)?),
                TypeDefKind::Result(t) => Kind::Result(
                    t.ok.map(|t| self.add(r, t)).transpose()?,
                    t.err.map(|t| self.add(r, t)).transpose()?,
                ),
                TypeDefKind::Tuple(t) => Kind::Tuple(
                    t.types.iter().map(|t| self.add(r, *t)).collect::<Result<_>>()?,
                ),
                TypeDefKind::Record(t) => Kind::Record(
                    t.fields.iter().map(|f| Ok((f.name.clone(), self.add(r, f.ty)?))).collect::<Result<_>>()?,
                ),
                TypeDefKind::Variant(t) => Kind::Variant(
                    t.cases.iter().map(|f| Ok((f.name.clone(), f.ty.map(|t| self.add(r,t)).transpose()?))).collect::<Result<_>>()?,
                ),
                TypeDefKind::Enum(t) => Kind::Enum(t.cases.iter().map(|c| c.name.clone()).collect()),
                TypeDefKind::Flags(t) => Kind::Flags(t.flags.iter().map(|c| c.name.clone()).collect()),
                _ => return Err("Core value bindings do not support resources, streams, nested futures or fixed-size lists; use --component".into()),
            }
        } else {
            match source {
                Type::Bool
                | Type::U8
                | Type::S8
                | Type::U16
                | Type::S16
                | Type::U32
                | Type::S32
                | Type::U64
                | Type::S64
                | Type::F32
                | Type::F64
                | Type::Char
                | Type::String => Kind::Primitive(source),
                _ => return Err("unsupported Core value type; use --component".into()),
            }
        };
        if let Some(n) = &name {
            let n = pascal(n);
            // Reject collisions before emitting an unusable public .d.ts.
            if [
                "Guest",
                "HostResult",
                "WitInput",
                "AppBindings",
                "CallOptions",
                "HostContext",
                "Resource",
                "ResourceTypes",
                "HostValue",
                "Borrowed",
                "AppExports",
                "AppHost",
                "AppHostOptions",
                "Host",
                "HostOptions",
                "JspiHost",
                "JspiHostOptions",
                "Array",
                "ReadonlyArray",
                "Promise",
                "PromiseLike",
                "WebAssembly",
                "Omit",
                "Int8Array",
                "Uint8Array",
                "Int16Array",
                "Uint16Array",
                "Int32Array",
                "Uint32Array",
                "BigInt64Array",
                "BigUint64Array",
                "Float32Array",
                "Float64Array",
            ]
            .contains(&n.as_str())
                || self
                    .nodes
                    .iter()
                    .any(|t| t.name.as_ref().is_some_and(|x| pascal(x) == n))
            {
                return Err(format!("Core generated type name collision: {n}").into());
            }
        }
        let id = self.nodes.len();
        self.nodes.push(Node { source, name, kind });
        Ok(id)
    }
    pub fn has_resources(&self) -> bool {
        self.nodes.iter().any(|n| matches!(n.kind, Kind::Resource))
    }
    pub fn borrowed(&self, id: usize) -> Option<usize> {
        match self.nodes[id].kind {
            Kind::Borrow(t) => Some(t),
            Kind::Alias(t) => self.borrowed(t),
            _ => None,
        }
    }
    pub fn contains_borrow(&self, id: usize) -> bool {
        match &self.nodes[id].kind {
            Kind::Borrow(_) => true,
            Kind::Alias(t) | Kind::List(t) | Kind::Option(t) => self.contains_borrow(*t),
            Kind::Record(fs) => fs.iter().any(|(_, t)| self.contains_borrow(*t)),
            Kind::Tuple(ts) => ts.iter().any(|t| self.contains_borrow(*t)),
            Kind::Result(a, b) => a.iter().chain(b).any(|t| self.contains_borrow(*t)),
            Kind::Variant(cs) => cs
                .iter()
                .filter_map(|(_, t)| *t)
                .any(|t| self.contains_borrow(t)),
            _ => false,
        }
    }
    pub fn contains_resource(&self, id: usize) -> bool {
        match &self.nodes[id].kind {
            Kind::Resource | Kind::Own(_) | Kind::Borrow(_) => true,
            Kind::Alias(t) | Kind::List(t) | Kind::Option(t) => self.contains_resource(*t),
            Kind::Record(fs) => fs.iter().any(|(_, t)| self.contains_resource(*t)),
            Kind::Tuple(ts) => ts.iter().any(|t| self.contains_resource(*t)),
            Kind::Result(a, b) => a.iter().chain(b).any(|t| self.contains_resource(*t)),
            Kind::Variant(cs) => cs
                .iter()
                .filter_map(|(_, t)| *t)
                .any(|t| self.contains_resource(t)),
            _ => false,
        }
    }
    pub fn host_js(&self, id: usize, value: &str, from_host: bool) -> String {
        if !self.contains_resource(id) {
            return value.into();
        }
        let recurse = |t, v: &str| self.host_js(t, v, from_host);
        match &self.nodes[id].kind {
            Kind::Resource | Kind::Own(_) => format!(
                "resources.{}({value})",
                if from_host { "wrap" } else { "toHostOwn" }
            ),
            Kind::Borrow(_) => format!("resources.peek({value})"),
            Kind::Alias(t) => recurse(*t, value),
            Kind::List(t) => format!("{value}.map(x=>{})", recurse(*t, "x")),
            Kind::Option(t) => format!("({value}===undefined?undefined:{})", recurse(*t, value)),
            Kind::Record(fs) => format!(
                "({{...{value},{}}})",
                fs.iter()
                    .filter(|(_, t)| self.contains_resource(*t))
                    .map(|(n, t)| format!(
                        "{}:{}",
                        json(n),
                        recurse(*t, &format!("{value}[{}]", json(n)))
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Kind::Tuple(ts) => format!(
                "[{}]",
                ts.iter()
                    .enumerate()
                    .map(|(i, t)| recurse(*t, &format!("{value}[{i}]")))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Kind::Result(ok, err) => format!(
                "({value}.tag===\"ok\"?{}:{})",
                ok.map(|t| format!(
                    "({{...{value},val:{}}})",
                    recurse(t, &format!("{value}.val"))
                ))
                .unwrap_or(value.into()),
                err.map(|t| format!(
                    "({{...{value},val:{}}})",
                    recurse(t, &format!("{value}.val"))
                ))
                .unwrap_or(value.into())
            ),
            Kind::Variant(cs) => {
                cs.iter()
                    .filter_map(|(n, t)| {
                        t.filter(|t| self.contains_resource(*t)).map(|t| {
                            format!(
                                "{value}.tag==={}?({{...{value},val:{}}}):",
                                json(n),
                                recurse(t, &format!("{value}.val"))
                            )
                        })
                    })
                    .collect::<String>()
                    + value
            }
            _ => value.into(),
        }
    }
    pub fn has_codecs(&self) -> bool {
        !self.codecs.is_empty()
    }
    pub fn use_codec(&mut self, id: usize) {
        if !self.codecs.insert(id) {
            return;
        }
        let children = match &self.nodes[id].kind {
            Kind::Primitive(_) | Kind::Enum(_) | Kind::Flags(_) | Kind::Resource => Vec::new(),
            Kind::List(t) | Kind::Option(t) | Kind::Alias(t) | Kind::Own(t) | Kind::Borrow(t) => {
                vec![*t]
            }
            Kind::Tuple(ts) => ts.clone(),
            Kind::Result(ok, err) => ok.iter().chain(err).copied().collect(),
            Kind::Record(fs) => fs.iter().map(|(_, t)| *t).collect(),
            Kind::Variant(cs) => cs.iter().filter_map(|(_, t)| *t).collect(),
        };
        for t in children {
            self.use_codec(t);
        }
    }
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
    fn wit_name(&self, id: usize) -> String {
        format!(
            "%{}",
            self.nodes[id]
                .name
                .clone()
                .unwrap_or_else(|| format!("taraba-type-{id}"))
        )
    }
    pub fn wit(&self, id: usize) -> String {
        match self.nodes[id].kind {
            Kind::Own(t) => format!("own<{}>", self.wit(t)),
            Kind::Borrow(t) => format!("borrow<{}>", self.wit(t)),
            Kind::Primitive(t) => primitive_wit(t).into(),
            _ => self.wit_name(id),
        }
    }
    pub fn rust_type(&self, id: usize) -> String {
        if let Some(n) = &self.nodes[id].name {
            return pascal(n);
        }
        self.rust_shape(id)
    }
    fn optional_rust(&self, id: Option<usize>) -> String {
        id.map(|i| self.rust_type(i)).unwrap_or_else(|| "()".into())
    }
    fn rust_shape(&self, id: usize) -> String {
        match &self.nodes[id].kind {
            Kind::Primitive(t) => match t {
                Type::String => "__taraba_types::alloc::string::String".into(),
                Type::Bool => "bool".into(),
                Type::Char => "char".into(),
                _ => primitive_wit(*t).replace('s', "i"),
            },
            Kind::List(t) => format!("__taraba_types::alloc::vec::Vec<{}>", self.rust_type(*t)),
            Kind::Option(t) => format!("::core::option::Option<{}>", self.rust_type(*t)),
            Kind::Result(ok, err) => format!(
                "::core::result::Result<{},{}>",
                self.optional_rust(*ok),
                self.optional_rust(*err)
            ),
            Kind::Tuple(ts) => {
                if ts.is_empty() {
                    "()".into()
                } else {
                    format!(
                        "({},)",
                        ts.iter()
                            .map(|t| self.rust_type(*t))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
            }
            Kind::Own(t) => self.rust_type(*t),
            Kind::Borrow(t) => format!("Borrowed<{}>", self.rust_type(*t)),
            Kind::Alias(t) => self.rust_type(*t),
            _ => pascal(self.nodes[id].name.as_ref().expect("named WIT type")),
        }
    }
    fn public_name(&self, id: usize) -> Option<String> {
        self.nodes[id]
            .name
            .as_ref()
            .filter(|name| {
                !name
                    .strip_prefix("taraba-type-")
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
            })
            .map(|name| pascal(name))
    }
    pub fn ts(&self, id: usize) -> String {
        self.public_name(id).unwrap_or_else(|| self.ts_shape(id))
    }
    pub fn typescript(&self) -> String {
        if self.is_empty() {
            return String::new();
        }
        let mut out = String::from(
            r#"/** Accepted JS inputs are copied; readonly containers are never mutated. */
export type WitInput<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends BigInt64Array | BigUint64Array ? T | ReadonlyArray<bigint> :
  T extends Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array ? T | ReadonlyArray<number> :
  T extends readonly unknown[] ? { readonly [K in keyof T]: WitInput<T[K]> } :
  T extends object ? { readonly [K in keyof T]: WitInput<T[K]> } : T;
"#,
        );
        if self.has_resources() {
            out = String::from("/// <reference lib=\"esnext.disposable\" />\n") + &out;
            out.push_str("declare const resourceBrand:unique symbol;\nexport interface Resource<K extends string=string> extends Disposable {readonly [resourceBrand]:K}\nexport interface ResourceTypes {\n");
            for (id, n) in self.nodes.iter().enumerate() {
                if matches!(n.kind, Kind::Resource) {
                    out.push_str(&format!("{}:Disposable;\n", json(&self.rust_type(id))))
                }
            }
            out.push_str("}\nexport type HostValue<T,R extends ResourceTypes> = T extends Resource<infer K> ? K extends keyof R ? R[K] : never : T extends (...args:never[])=>unknown ? T : T extends readonly unknown[] ? { [K in keyof T]:HostValue<T[K],R> } : T extends object ? { [K in keyof T]:HostValue<T[K],R> }:T;\n");
        }
        for id in 0..self.nodes.len() {
            if let Some(name) = self.public_name(id) {
                out.push_str(&format!("export type {name} = {};\n", self.ts_shape(id)));
            }
        }
        out
    }
    fn primitive(&self, id: usize) -> Option<Type> {
        match self.nodes[id].kind {
            Kind::Primitive(t) => Some(t),
            Kind::Alias(t) => self.primitive(t),
            _ => None,
        }
    }
    fn numeric_list(&self, id: usize) -> Option<(&'static str, &'static str)> {
        Some(match self.primitive(id)? {
            Type::U8 => ("u8", "Uint8Array"),
            Type::S8 => ("i8", "Int8Array"),
            Type::U16 => ("u16", "Uint16Array"),
            Type::S16 => ("i16", "Int16Array"),
            Type::U32 => ("u32", "Uint32Array"),
            Type::S32 => ("i32", "Int32Array"),
            Type::U64 => ("u64", "BigUint64Array"),
            Type::S64 => ("i64", "BigInt64Array"),
            Type::F32 => ("f32", "Float32Array"),
            Type::F64 => ("f64", "Float64Array"),
            _ => return None,
        })
    }
    fn option_payload(&self, id: usize) -> Option<usize> {
        match self.nodes[id].kind {
            Kind::Option(t) => Some(t),
            Kind::Alias(t) => self.option_payload(t),
            _ => None,
        }
    }
    pub fn accepts_undefined(&self, id: usize) -> bool {
        self.option_payload(id)
            .is_some_and(|t| self.option_payload(t).is_none())
    }
    fn ts_shape(&self, id: usize) -> String {
        let child = |t: usize| self.ts(t);
        let tagged = |tag: &str, t: Option<usize>| {
            format!(
                "{{ tag: {}; {} }}",
                json(tag),
                t.map(|t| format!("val: {}", child(t))).unwrap_or_default()
            )
        };
        match &self.nodes[id].kind {
            Kind::Resource => format!("Resource<{}>", json(&self.rust_type(id))),
            Kind::Own(t) | Kind::Borrow(t) => child(*t),
            Kind::Primitive(t) => match t {
                Type::String | Type::Char => "string",
                Type::Bool => "boolean",
                Type::S64 | Type::U64 => "bigint",
                _ => "number",
            }
            .into(),
            Kind::List(t) => self
                .numeric_list(*t)
                .map(|(_, name)| name.into())
                .unwrap_or_else(|| format!("Array<{}>", child(*t))),
            Kind::Option(t) => {
                if self.option_payload(*t).is_none() {
                    format!("({} | undefined)", child(*t))
                } else {
                    format!("({} | {})", tagged("none", None), tagged("some", Some(*t)))
                }
            }
            Kind::Result(ok, err) => format!("({} | {})", tagged("ok", *ok), tagged("err", *err)),
            Kind::Tuple(ts) => format!(
                "[{}]",
                ts.iter().map(|t| child(*t)).collect::<Vec<_>>().join(",")
            ),
            Kind::Record(fs) => format!(
                "{{ {} }}",
                fs.iter()
                    .map(|(n, t)| format!(
                        "{}{}: {}",
                        json(n),
                        if self.accepts_undefined(*t) { "?" } else { "" },
                        child(*t)
                    ))
                    .collect::<Vec<_>>()
                    .join(";")
            ),
            Kind::Variant(cs) => format!(
                "({})",
                cs.iter()
                    .map(|(n, t)| tagged(n, *t))
                    .collect::<Vec<_>>()
                    .join(" | ")
            ),
            Kind::Enum(cs) => cs.iter().map(|n| json(n)).collect::<Vec<_>>().join(" | "),
            Kind::Flags(fs) => format!(
                "{{ {} }}",
                fs.iter()
                    .map(|n| format!("{}: boolean", json(n)))
                    .collect::<Vec<_>>()
                    .join(";")
            ),
            Kind::Alias(t) => child(*t),
        }
    }
    pub fn declarations(&self) -> String {
        let mut out = String::new();
        for (id, n) in self.nodes.iter().enumerate() {
            let name = self.wit_name(id);
            let child = |t| self.wit(t);
            let declaration = match &n.kind {
                Kind::Primitive(_) | Kind::Own(_) | Kind::Borrow(_) => continue,
                Kind::Resource => format!("resource {name};"),
                Kind::Record(fs) => format!(
                    "record {name} {{ {} }}",
                    fs.iter()
                        .map(|(n, t)| format!("%{n}:{}", child(*t)))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                Kind::Flags(fs) => format!(
                    "flags {name} {{ {} }}",
                    fs.iter()
                        .map(|n| format!("%{n}"))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                Kind::Enum(cs) => format!(
                    "enum {name} {{ {} }}",
                    cs.iter()
                        .map(|n| format!("%{n}"))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                Kind::Variant(cs) => format!(
                    "variant {name} {{ {} }}",
                    cs.iter()
                        .map(|(n, t)| format!(
                            "%{n}{}",
                            t.map(|t| format!("({})", child(t))).unwrap_or_default()
                        ))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                kind => {
                    let shape = match kind {
                        Kind::List(t) => format!("list<{}>", child(*t)),
                        Kind::Option(t) => format!("option<{}>", child(*t)),
                        Kind::Result(ok, err) => match (ok, err) {
                            (None, None) => "result".into(),
                            (Some(ok), None) => format!("result<{}>", child(*ok)),
                            (ok, Some(err)) => format!(
                                "result<{},{}>",
                                ok.map(child).unwrap_or_else(|| "_".into()),
                                child(*err)
                            ),
                        },
                        Kind::Tuple(ts) => format!(
                            "tuple<{}>",
                            ts.iter().map(|t| child(*t)).collect::<Vec<_>>().join(",")
                        ),
                        Kind::Alias(t) => child(*t),
                        _ => unreachable!(),
                    };
                    format!("type {name} = {shape};")
                }
            };
            out.push_str(&declaration);
            out.push('\n');
        }
        out
    }
    pub fn generate(&self) -> Result<Generated> {
        let mut g = Generated {
            wire: String::new(),
            javascript: BTreeMap::new(),
            rust: String::new(),
        };
        if self.is_empty() {
            return Ok(g);
        }
        let mut definitions = String::new();
        if self.has_resources() {
            definitions.push_str("pub struct Borrowed<T>{resource:T} impl<T> ::core::ops::Deref for Borrowed<T>{type Target=T;fn deref(&self)->&T{&self.resource}}\n");
        }
        let mut code = String::from(
            "#[allow(dead_code, unused_variables, unused_mut)] mod __taraba_types { pub extern crate alloc; use super::*; use super::__taraba_wire as wire;\nfn invalid() -> ! { #[cfg(target_arch=\"wasm32\")] {::core::arch::wasm32::unreachable()} #[cfg(not(target_arch=\"wasm32\"))] {panic!(\"invalid WIT value\")} }\n",
        );
        for (id, n) in self.nodes.iter().enumerate() {
            if let Some(name) = &n.name {
                let name = pascal(name);
                let declaration = match &n.kind {
                    Kind::Resource => format!(
                        "pub struct {name} {{value:Option<__taraba_wire::Value>, borrowed:bool}} impl ::core::ops::Drop for {name} {{fn drop(&mut self){{if let Some(v)=self.value.take(){{__taraba_types::finish_{id}(&v,self.borrowed)}}}}}} impl ::core::fmt::Debug for {name}{{fn fmt(&self,f:&mut ::core::fmt::Formatter<'_>)->::core::fmt::Result{{f.write_str(\"{name}\")}}}}"
                    ),
                    Kind::Record(fs) => format!(
                        "pub struct {name} {{ {} }}",
                        fs.iter()
                            .map(|(f, t)| Ok(format!(
                                "pub {}: {}",
                                rust_ident(f)?,
                                self.rust_type(*t)
                            )))
                            .collect::<Result<Vec<_>>>()?
                            .join(",")
                    ),
                    Kind::Flags(fs) => format!(
                        "pub struct {name} {{ {} }}",
                        fs.iter()
                            .map(|f| Ok(format!("pub {}:bool", rust_ident(f)?)))
                            .collect::<Result<Vec<_>>>()?
                            .join(",")
                    ),
                    Kind::Variant(cs) => format!(
                        "pub enum {name} {{ {} }}",
                        cs.iter()
                            .map(|(n, t)| format!(
                                "{}{}",
                                pascal(n),
                                t.map(|t| format!("({})", self.rust_type(t)))
                                    .unwrap_or_default()
                            ))
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                    Kind::Enum(cs) => format!(
                        "pub enum {name} {{ {} }}",
                        cs.iter().map(|n| pascal(n)).collect::<Vec<_>>().join(",")
                    ),
                    _ => format!("pub type {name} = {};", self.rust_shape(id)),
                };
                if matches!(
                    n.kind,
                    Kind::Record(_) | Kind::Flags(_) | Kind::Variant(_) | Kind::Enum(_)
                ) {
                    definitions.push_str(if self.contains_resource(id) {
                        "#[derive(Debug)]\n"
                    } else {
                        "#[derive(Debug, Clone, PartialEq)]\n"
                    });
                }
                definitions.push_str(&declaration);
                definitions.push('\n');
            }
            if !self.codecs.contains(&id) {
                continue;
            }
            let mut op = |suffix: &str, args: &str, result: &str, js: &str| -> String {
                let name = format!("taraba-codec-{id}-{suffix}");
                g.wire
                    .push_str(&format!("import {name}:func({args}){result};\n"));
                g.javascript.insert(name.clone(), js.into());
                name.replace('-', "_")
            };
            let ty = self.rust_type(id);
            let encode_ty = self
                .borrowed(id)
                .map(|t| format!("&{}", self.rust_type(t)))
                .unwrap_or_else(|| ty.clone());
            let (encode, decode) = match &n.kind {
                Kind::Resource => {
                    let finish = op(
                        "finish",
                        "v:borrow<value>,borrowed:u32",
                        "",
                        "(v,borrowed)=>{borrowed?resources.end(v):resources.drop(v)}",
                    );
                    code.push_str(&format!("pub fn finish_{id}(v:&wire::Value,borrowed:bool){{wire::{finish}(v,borrowed as u32)}}\n"));
                    let give = op("give", "v:borrow<value>", "->value", "v=>resources.give(v)");
                    let take = op("take", "v:borrow<value>", "->value", "v=>resources.take(v)");
                    (
                        format!("let value=v.value.take().unwrap(); wire::{give}(&value)"),
                        format!("{ty}{{value:Some(wire::{take}(v)),borrowed:false}}"),
                    )
                }
                Kind::Own(t) => (format!("encode_{t}(v)"), format!("decode_{t}(v)")),
                Kind::Borrow(t) => {
                    let encode = op("borrow", "v:borrow<value>", "->value", "v=>v");
                    let begin = op(
                        "begin",
                        "v:borrow<value>",
                        "->value",
                        "v=>resources.begin(v)",
                    );
                    let child = self.rust_type(*t);
                    (
                        format!("wire::{encode}(v.value.as_ref().unwrap())"),
                        format!(
                            "Borrowed{{resource:{child}{{value:Some(wire::{begin}(v)),borrowed:true}}}}"
                        ),
                    )
                }
                Kind::Primitive(Type::String) => {
                    let enc = op(
                        "encode",
                        "p:u32,n:u32",
                        "->value",
                        "(p,n)=>decoder.decode(new Uint8Array(memory.buffer,p,n))",
                    );
                    let len = op(
                        "len",
                        "v:borrow<value>",
                        "->u32",
                        "v=>encoder.encode(v).length",
                    );
                    let copy = op(
                        "copy",
                        "v:borrow<value>,p:u32,n:u32",
                        "",
                        "(v,p,n)=>{encoder.encodeInto(v,new Uint8Array(memory.buffer,p,n));}",
                    );
                    (
                        format!("wire::{enc}(v.as_ptr() as u32,v.len() as u32)"),
                        format!(
                            "let n=wire::{len}(v) as usize; let mut bytes=alloc::vec![0;n]; wire::{copy}(v,bytes.as_mut_ptr() as u32,n as u32); // SAFETY: the reserved generated copy import uses TextEncoder.encodeInto, which writes only complete UTF-8 sequences. Unwritten bytes are initialized to zero. The destination is a fresh Vec owned by this call.\nunsafe {{alloc::string::String::from_utf8_unchecked(bytes)}}"
                        ),
                    )
                }
                Kind::Primitive(Type::U64 | Type::S64) => {
                    let signed = matches!(n.kind, Kind::Primitive(Type::S64));
                    let enc = op(
                        "encode",
                        "lo:u32,hi:u32",
                        "->value",
                        &format!(
                            "(lo,hi)=>{}(64,(BigInt(hi)<<32n)|BigInt(lo))",
                            if signed {
                                "BigInt.asIntN"
                            } else {
                                "BigInt.asUintN"
                            }
                        ),
                    );
                    let lo = op(
                        "low",
                        "v:borrow<value>",
                        "->u32",
                        "v=>Number(BigInt.asUintN(32,v))",
                    );
                    let hi = op(
                        "high",
                        "v:borrow<value>",
                        "->u32",
                        "v=>Number(BigInt.asUintN(32,v>>32n))",
                    );
                    (
                        format!("wire::{enc}(v as u32,((v as u64)>>32) as u32)"),
                        format!("((wire::{lo}(v) as u64)|((wire::{hi}(v) as u64)<<32)) as {ty}"),
                    )
                }
                Kind::Primitive(t) => {
                    let (enc_js, dec_js) = match t {
                        Type::Bool => ("v=>v!==0", "v=>v?1:0"),
                        Type::Char => ("v=>String.fromCodePoint(v)", "v=>v.codePointAt(0)"),
                        _ => ("v=>v", "v=>v"),
                    };
                    let enc = op("encode", "v:f64", "->value", enc_js);
                    let dec = op("decode", "v:borrow<value>", "->f64", dec_js);
                    let enc_v = if matches!(t, Type::Bool | Type::Char) {
                        "v as u32 as f64"
                    } else {
                        "v as f64"
                    };
                    let decoded = match t {
                        Type::Bool => format!("wire::{dec}(v)!=0.0"),
                        Type::Char => {
                            format!(
                                "::core::char::from_u32(wire::{dec}(v) as u32).unwrap_or_else(||invalid())"
                            )
                        }
                        _ => format!("wire::{dec}(v) as {ty}"),
                    };
                    (format!("wire::{enc}({enc_v})"), decoded)
                }
                Kind::Alias(t) => (format!("encode_{t}(v)"), format!("decode_{t}(v)")),
                Kind::List(t) if self.numeric_list(*t).is_some() => {
                    let (element, array) = self.numeric_list(*t).unwrap();
                    let enc = op(
                        "encode",
                        "p:u32,n:u32",
                        "->value",
                        &format!("(p,n)=>new {array}(new {array}(memory.buffer,p,n))"),
                    );
                    let len = op("len", "v:borrow<value>", "->u32", "v=>v.length");
                    let copy = op(
                        "copy",
                        "v:borrow<value>,p:u32,n:u32",
                        "",
                        &format!("(v,p,n)=>{{new {array}(memory.buffer,p,n).set(v);}}"),
                    );
                    (
                        format!("wire::{enc}(v.as_ptr() as u32,v.len() as u32)"),
                        format!(
                            "let n=wire::{len}(v) as usize; let mut values=alloc::vec![0 as {element};n]; wire::{copy}(v,values.as_mut_ptr() as u32,n as u32); values"
                        ),
                    )
                }
                Kind::List(t) => {
                    let make = op("make", "", "->value", "()=>[]");
                    let push = op("push", "v:borrow<value>,x:value", "", "(v,x)=>{v.push(x);}");
                    let len = op("len", "v:borrow<value>", "->u32", "v=>v.length");
                    let get = op("get", "v:borrow<value>,i:u32", "->value", "(v,i)=>v[i]");
                    (
                        format!(
                            "let result=wire::{make}(); for item in v {{wire::{push}(&result,encode_{t}(item));}} result"
                        ),
                        format!(
                            "(0..wire::{len}(v)).map(|i|decode_{t}(&wire::{get}(v,i))).collect()"
                        ),
                    )
                }
                Kind::Record(fs) => self.aggregate(
                    &ty,
                    &fs.iter()
                        .map(|(n, t)| Ok((n.clone(), rust_ident(n)?, Some(*t))))
                        .collect::<Result<Vec<_>>>()?,
                    false,
                    &mut op,
                ),
                Kind::Tuple(ts) => self.aggregate(
                    &ty,
                    &ts.iter()
                        .enumerate()
                        .map(|(i, t)| (i.to_string(), i.to_string(), Some(*t)))
                        .collect::<Vec<_>>(),
                    true,
                    &mut op,
                ),
                Kind::Option(t) => self.tagged(
                    &[("none".into(), None), ("some".into(), Some(*t))],
                    &["None".into(), "Some".into()],
                    self.option_payload(*t).is_none(),
                    &mut op,
                ),
                Kind::Result(ok, err) => self.tagged(
                    &[("ok".into(), *ok), ("err".into(), *err)],
                    &[
                        if ok.is_some() {
                            "Ok".into()
                        } else {
                            "Ok(())".into()
                        },
                        if err.is_some() {
                            "Err".into()
                        } else {
                            "Err(())".into()
                        },
                    ],
                    false,
                    &mut op,
                ),
                Kind::Variant(cs) => self.tagged(
                    cs,
                    &cs.iter()
                        .map(|(n, _)| format!("{ty}::{}", pascal(n)))
                        .collect::<Vec<_>>(),
                    false,
                    &mut op,
                ),
                Kind::Enum(cs) => {
                    let enc = op(
                        "encode",
                        "n:u32",
                        "->value",
                        &format!(
                            "n=>[{}][n]",
                            cs.iter().map(|c| json(c)).collect::<Vec<_>>().join(",")
                        ),
                    );
                    let dec = op(
                        "decode",
                        "v:borrow<value>",
                        "->u32",
                        &format!(
                            "v=>[{}].indexOf(v)",
                            cs.iter().map(|c| json(c)).collect::<Vec<_>>().join(",")
                        ),
                    );
                    (
                        format!(
                            "wire::{enc}(match v {{{}}})",
                            cs.iter()
                                .enumerate()
                                .map(|(i, n)| format!("{ty}::{}=>{i}", pascal(n)))
                                .collect::<Vec<_>>()
                                .join(",")
                        ),
                        format!(
                            "match wire::{dec}(v) {{{},_=>invalid()}}",
                            cs.iter()
                                .enumerate()
                                .map(|(i, n)| format!("{i}=>{ty}::{}", pascal(n)))
                                .collect::<Vec<_>>()
                                .join(",")
                        ),
                    )
                }
                Kind::Flags(fs) => self.aggregate(
                    &ty,
                    &fs.iter()
                        .map(|n| Ok((n.clone(), rust_ident(n)?, None)))
                        .collect::<Result<Vec<_>>>()?,
                    false,
                    &mut op,
                ),
            };
            code.push_str(&format!("pub(super) fn encode_{id}(mut v: {encode_ty})->wire::Value {{{encode}}}\npub(super) fn decode_{id}(v:&wire::Value)->{ty} {{{decode}}}\n"));
        }
        code.push_str("}\n");
        g.rust = definitions + &code;
        Ok(g)
    }
    /// Keep small constructors flat; above Canonical ABI's 16-argument limit,
    /// initialize fields separately so wire imports never spill to memory.
    fn aggregate(
        &self,
        ty: &str,
        fields: &[(String, String, Option<usize>)],
        array: bool,
        op: &mut impl FnMut(&str, &str, &str, &str) -> String,
    ) -> (String, String) {
        let wide = fields.len() > 16;
        let args = fields
            .iter()
            .enumerate()
            .map(|(i, (_, _, t))| format!("a{i}:{}", if t.is_some() { "value" } else { "u32" }))
            .collect::<Vec<_>>()
            .join(",");
        let values = fields
            .iter()
            .enumerate()
            .map(|(i, (_, _, t))| {
                if t.is_some() {
                    format!("a{i}")
                } else {
                    format!("a{i}!==0")
                }
            })
            .collect::<Vec<_>>();
        let object = if array {
            format!("[{}]", values.join(","))
        } else {
            format!(
                "({{{}}})",
                fields
                    .iter()
                    .zip(&values)
                    .map(|((key, ..), v)| format!("{}:{v}", json(key)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        };
        let constructor = if wide {
            if array {
                "()=>[]".into()
            } else {
                "()=>({})".into()
            }
        } else {
            format!(
                "({})=>{object}",
                (0..fields.len())
                    .map(|i| format!("a{i}"))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        };
        let make = op(
            "make",
            if wide { "" } else { &args },
            "->value",
            &constructor,
        );
        let mut encode = Vec::new();
        let mut decode = Vec::new();
        for (i, (key, access, t)) in fields.iter().enumerate() {
            let value = t
                .map(|t| format!("encode_{t}(v.{access})"))
                .unwrap_or_else(|| format!("v.{access} as u32"));
            if wide {
                let setter = op(
                    &format!("set-{i}"),
                    &format!(
                        "v:borrow<value>,x:{}",
                        if t.is_some() { "value" } else { "u32" }
                    ),
                    "",
                    &format!(
                        "(v,x)=>{{v[{}]={};}}",
                        json(key),
                        if t.is_some() { "x" } else { "x!==0" }
                    ),
                );
                encode.push(format!("wire::{setter}(&result,{value});"));
            } else {
                encode.push(value);
            }
            let get = op(
                &format!("get-{i}"),
                "v:borrow<value>",
                if t.is_some() { "->value" } else { "->u32" },
                &format!(
                    "v=>v[{}]{}",
                    json(key),
                    if t.is_some() { "" } else { "?1:0" }
                ),
            );
            let value = t
                .map(|t| format!("decode_{t}(&wire::{get}(v))"))
                .unwrap_or_else(|| format!("wire::{get}(v)!=0"));
            decode.push(if array {
                value
            } else {
                format!("{access}: {value}")
            });
        }
        let encode = if wide {
            format!("let result=wire::{make}(); {} result", encode.join(""))
        } else {
            format!("wire::{make}({})", encode.join(","))
        };
        let decode = if array {
            if fields.is_empty() {
                "()".into()
            } else {
                format!("({},)", decode.join(","))
            }
        } else {
            format!("{ty}{{{}}}", decode.join(","))
        };
        (encode, decode)
    }
    fn tagged(
        &self,
        cs: &[(String, Option<usize>)],
        patterns: &[String],
        flat: bool,
        op: &mut impl FnMut(&str, &str, &str, &str) -> String,
    ) -> (String, String) {
        let names = cs
            .iter()
            .map(|(n, _)| json(n))
            .collect::<Vec<_>>()
            .join(",");
        let make = op(
            "make",
            "n:u32,v:value",
            "->value",
            &if flat {
                "(n,v)=>n?v:undefined".into()
            } else {
                format!("(n,v)=>({{tag:[{names}][n],val:v}})")
            },
        );
        let tag = op(
            "tag",
            "v:borrow<value>",
            "->u32",
            &if flat {
                "v=>v===undefined?0:1".into()
            } else {
                format!("v=>[{names}].indexOf(v.tag)")
            },
        );
        let get = if cs.iter().any(|(_, t)| t.is_some()) {
            Some(op(
                "payload",
                "v:borrow<value>",
                "->value",
                if flat { "v=>v" } else { "v=>v.val" },
            ))
        } else {
            None
        };
        // Handle zero is the reserved undefined root in this private ABI; its Drop is a no-op.
        // No linear-memory data or live root is borrowed through this unit placeholder.
        let enc = cs
            .iter()
            .zip(patterns)
            .enumerate()
            .map(|(i, ((_, t), pat))| match t {
                Some(t) => format!("{pat}(x)=>wire::{make}({i},encode_{t}(x))"),
                None => format!("{pat}=>wire::{make}({i},unsafe {{wire::Value::from_handle(0)}})"),
            })
            .collect::<Vec<_>>()
            .join(",");
        let dec = cs
            .iter()
            .zip(patterns)
            .enumerate()
            .map(|(i, ((_, t), pat))| match t {
                Some(t) => format!(
                    "{i}=>{pat}(decode_{t}(&wire::{}(v)))",
                    get.as_ref().unwrap()
                ),
                None => format!("{i}=>{pat}"),
            })
            .collect::<Vec<_>>()
            .join(",");
        (
            format!("match v {{{enc}}}"),
            format!("match wire::{tag}(v) {{{dec},_=>invalid()}}"),
        )
    }
}
fn primitive_wit(t: Type) -> &'static str {
    match t {
        Type::Bool => "bool",
        Type::U8 => "u8",
        Type::S8 => "s8",
        Type::U16 => "u16",
        Type::S16 => "s16",
        Type::U32 => "u32",
        Type::S32 => "s32",
        Type::U64 => "u64",
        Type::S64 => "s64",
        Type::F32 => "f32",
        Type::F64 => "f64",
        Type::Char => "char",
        Type::String => "string",
        _ => unreachable!(),
    }
}
