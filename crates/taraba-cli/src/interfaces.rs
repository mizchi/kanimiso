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
}
pub(crate) struct Flat {
    pub resolve: Resolve,
    pub members: BTreeMap<String, Member>,
}
fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
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
                let (method, constructor) = match f.kind {
                    FunctionKind::Constructor(resource) if !export => source.types[resource]
                        .name.clone().map(|name| (name, true)).ok_or("unnamed Core resource constructor")?,
                    FunctionKind::Freestanding if !export && name.starts_with("taraba-interface-") && f.name.starts_with("taraba-constructor-") =>
                        (f.name["taraba-constructor-".len()..].to_owned(), true),
                    FunctionKind::Freestanding | FunctionKind::AsyncFreestanding => (f.name.clone(), false),
                    _ => return Err("Core supports imported resource constructors; resource methods and exported resource implementations require --component".into()),
                };
                if !public_names.insert((export, namespace.clone(), method.clone())) {
                    return Err(format!("Core constructor/function binding name collision: {namespace}.{method}; rename the freestanding function").into());
                }
                let name = format!("taraba-iface-{}-{}", hex(&namespace), method);
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
                };
                if let Some(old) = members.insert(name.clone(), member.clone()) {
                    if old != member {
                        return Err("Core interface alias collision".into());
                    }
                }
                let mut f = f.clone();
                if matches!(f.kind, FunctionKind::Constructor(_)) {
                    f.kind = FunctionKind::Freestanding;
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
    fn constructors_keep_aliases_independent_and_reject_guest_implemented_resources() {
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
        assert!(
            crate::wit::parse(&path, None)
                .err()
                .unwrap()
                .to_string()
                .contains("--component")
        );
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
