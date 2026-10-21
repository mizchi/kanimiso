//! Normalize WIT interfaces into the private, flat Core wire namespace. Public
//! Rust and TS grouping is retained separately; no runtime name lookup is needed.
use std::{collections::BTreeMap, error::Error};
use wit_parser::*;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Member {
    pub namespace: String,
    pub method: String,
    pub identity: String,
    pub constructor: bool,
    pub resource: Option<String>,
    pub receiver: bool,
}
pub(crate) struct Flat {
    pub resolve: Resolve,
    pub members: BTreeMap<String, Member>,
}
fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}
pub(crate) fn unhex(s: &str) -> Result<String, Box<dyn Error>> {
    Ok(String::from_utf8(
        (0..s.len())
            .step_by(2)
            .map(|i| {
                u8::from_str_radix(s.get(i..i + 2).ok_or("invalid resource metadata")?, 16)
                    .map_err(Into::into)
            })
            .collect::<Result<Vec<_>, Box<dyn Error>>>()?,
    )?)
}
pub fn rust_namespace(s: &str) -> Result<String, Box<dyn Error>> {
    crate::core_async::rust_name(s)
}
pub(crate) fn flatten(source: &Resolve, world: WorldId) -> Result<Flat, Box<dyn Error>> {
    let mut resolve = source.clone();
    let mut members = BTreeMap::new();
    let mut public_names = std::collections::BTreeSet::new();
    for export in [false, true] {
        let items = if export {
            source.worlds[world].exports.clone()
        } else {
            source.worlds[world].imports.clone()
        };
        let dest = if export {
            &mut resolve.worlds[world].exports
        } else {
            &mut resolve.worlds[world].imports
        };
        dest.clear();
        for (key, item) in items {
            let WorldItem::Interface { id, .. } = item else {
                dest.insert(key, item);
                continue;
            };
            let interface = &source.interfaces[id];
            let namespace = match key {
                WorldKey::Name(n) => n,
                WorldKey::Interface(_) => interface
                    .name
                    .clone()
                    .ok_or("anonymous Core interface requires a world alias")?,
            };
            if namespace == "taraba-guest-resources" {
                continue;
            }
            rust_namespace(&namespace)?;
            let name = interface.name.as_deref().unwrap_or(&namespace);
            let identity = if name.starts_with("taraba-interface-") {
                name.to_owned()
            } else {
                format!(
                    "taraba-interface-{}",
                    hex(&source.id_of(id).unwrap_or_else(|| name.to_owned()))
                )
            };
            for f in interface.functions.values() {
                // Constructors are typed factories returning an owned resource.
                // They use the resource name in each interface namespace, so
                // aliases remain independent and no class/receiver is required.
                let mut resource = None;
                let mut receiver = false;
                let (method, constructor) = match f.kind {
                    FunctionKind::Constructor(resource) => source.types[resource]
                        .name
                        .clone()
                        .map(|name| (name, true))
                        .ok_or("unnamed Core resource constructor")?,
                    FunctionKind::Freestanding
                        if name.starts_with("taraba-interface-")
                            && f.name.starts_with("taraba-constructor-") =>
                    {
                        (f.name["taraba-constructor-".len()..].to_owned(), true)
                    }
                    FunctionKind::Method(id) | FunctionKind::AsyncMethod(id) => {
                        resource = Some(source.types[id].name.clone().ok_or("unnamed resource")?);
                        receiver = true;
                        (
                            f.name
                                .split_once('.')
                                .ok_or("invalid WIT method")?
                                .1
                                .to_owned(),
                            false,
                        )
                    }
                    FunctionKind::Freestanding | FunctionKind::AsyncFreestanding
                        if f.name.starts_with("taraba-method-")
                            && name.starts_with("taraba-interface-") =>
                    {
                        let (r, method) = f.name["taraba-method-".len()..]
                            .split_once('-')
                            .ok_or("invalid method metadata")?;
                        resource = Some(unhex(r)?);
                        receiver = true;
                        (method.to_owned(), false)
                    }
                    FunctionKind::Freestanding | FunctionKind::AsyncFreestanding => {
                        (f.name.clone(), false)
                    }
                    _ => return Err("Core resource static methods require --component".into()),
                };
                if receiver && method == "then" {
                    return Err(
                        "Core resource method then would create a thenable; rename it".into(),
                    );
                }
                if !public_names.insert((
                    export,
                    namespace.clone(),
                    resource.clone(),
                    method.clone(),
                )) {
                    return Err(format!("Core constructor/function binding name collision: {namespace}.{method}; rename the freestanding function").into());
                }
                let name = format!(
                    "taraba-iface-{}-{}{}",
                    hex(&namespace),
                    resource
                        .as_ref()
                        .map(|r| format!("taraba-method-{}-", hex(r)))
                        .unwrap_or_default(),
                    method
                );
                if source.worlds[world]
                    .imports
                    .contains_key(&WorldKey::Name(name.clone()))
                    || source.worlds[world]
                        .exports
                        .contains_key(&WorldKey::Name(name.clone()))
                {
                    return Err("Core interface wire name collides with a world function".into());
                }
                let member = Member {
                    namespace: namespace.clone(),
                    method,
                    identity: identity.clone(),
                    constructor,
                    resource,
                    receiver,
                };
                if let Some(old) = members.insert(name.clone(), member.clone()) {
                    if old != member {
                        return Err("Core interface alias collision".into());
                    }
                }
                let mut f = f.clone();
                f.kind = if matches!(f.kind, FunctionKind::AsyncMethod(_)) {
                    FunctionKind::AsyncFreestanding
                } else if matches!(
                    f.kind,
                    FunctionKind::Method(_) | FunctionKind::Constructor(_)
                ) {
                    FunctionKind::Freestanding
                } else {
                    f.kind
                };
                if receiver {
                    f.params[0].name = "self-resource".into();
                }
                f.name = name.clone();
                dest.insert(WorldKey::Name(name), WorldItem::Function(f));
            }
        }
    }
    // Interface-owned value types need unique names in the flat wire world.
    // Canonical public snapshots already use the shared taraba-values interface.
    for (id, ty) in resolve.types.iter_mut() {
        if let TypeOwner::Interface(owner) = source.types[id].owner {
            let interface = &source.interfaces[owner];
            if interface.name.as_deref() == Some("taraba-values")
                || interface
                    .name
                    .as_deref()
                    .is_some_and(|n| n.starts_with("taraba-interface-"))
            {
                continue;
            }
            if let (Some(prefix), Some(name)) = (&interface.name, &ty.name) {
                ty.name = Some(format!("{prefix}-{name}"));
            }
        }
    }
    Ok(Flat { resolve, members })
}

#[cfg(test)]
mod tests {
    #[test]
    fn imported_methods_have_receivers_and_round_trip_without_name_collisions() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app.wit");
        std::fs::write(&path,"package test:methods; interface handles {resource value {constructor(text:string);read:async func()->string;size:func()->u32;} read:func(v:u32)->u32;} world app {import io:handles;use handles.{value};export inspect:async func(v:borrow<value>)->string;}").unwrap();
        let a = crate::wit::parse(&path, None).unwrap();
        assert!(a == crate::wit::parse_contract(a.core_contract.as_ref().unwrap()).unwrap());
        assert_eq!(
            a.interface_members
                .values()
                .filter(|m| m.namespace == "io" && m.method == "read")
                .count(),
            2
        );
    }
    #[test]
    fn imported_constructors_lower_to_typed_factories_and_round_trip() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app.wit");
        std::fs::write(&path,"package test:constructors; interface handles {resource value {constructor(label:string);} read:async func(v:borrow<value>)->string;} world app {import io:handles;use handles.{value};export make:async func(label:string)->own<value>;}").unwrap();
        let a = crate::wit::parse(&path, None).unwrap();
        let b = crate::wit::parse_contract(a.core_contract.as_ref().unwrap()).unwrap();
        assert!(a == b, "constructor contract changed during normalization");
        assert!(a.interface_members.values().any(|m| m.method == "value"));
    }
    #[test]
    fn constructors_keep_aliases_independent_and_preserve_guest_resource_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app.wit");
        let source = "package test:constructors; interface handles {resource value {constructor();}} world app {import first:handles;import second:handles;}";
        std::fs::write(&path, source).unwrap();
        let a = crate::wit::parse(&path, None).unwrap();
        assert_eq!(
            a.interface_members
                .values()
                .filter(|m| m.constructor)
                .count(),
            2
        );
        assert!(a == crate::wit::parse_contract(a.core_contract.as_ref().unwrap()).unwrap());
        std::fs::write(
            &path,
            source.replace(
                "import first:handles;import second:handles;",
                "export api:handles;",
            ),
        )
        .unwrap();
        let guest = crate::wit::parse(&path, None).unwrap();
        assert!(
            guest == crate::wit::parse_contract(guest.core_contract.as_ref().unwrap()).unwrap()
        );
        assert_eq!(guest.guest_resources.len(), 1);
    }
    #[test]
    fn grouped_contract_is_canonical_and_keeps_same_named_methods() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app.wit");
        std::fs::write(&path,"package test:interfaces; interface source {record packet {id:u64,label:string,payload:list<u8>} run:async func(v:packet)->packet;} world app {import first:source;import second:source;export api:source;}").unwrap();
        let a = crate::wit::parse(&path, None).unwrap();
        let b = crate::wit::parse_contract(a.core_contract.as_ref().unwrap()).unwrap();
        assert_eq!(a.interface_members, b.interface_members);
        assert_eq!(a.core_contract, b.core_contract);
        assert_eq!(a.type_declarations, b.type_declarations);
        assert_eq!(a.codecs, b.codecs);
        assert!(a == b, "grouped contract changed wire signatures");
    }
}
