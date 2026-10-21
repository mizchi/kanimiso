//! Ownership metadata for Rust-defined resources in the private Core contract.
use std::{collections::BTreeMap, error::Error};
use wit_parser::*;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GuestResource {
    pub namespace: String,
    pub name: String,
}
impl GuestResource {
    pub fn associated(&self) -> String {
        format!(
            "<$guest as exports::{}::Guest>::{}",
            crate::interfaces::rust_namespace(&self.namespace).unwrap(),
            pascal(&self.name)
        )
    }
    pub fn trait_name(&self) -> String {
        format!("Guest{}", pascal(&self.name))
    }
}
pub fn pascal(s: &str) -> String {
    s.split('-')
        .map(|p| {
            let mut c = p.chars();
            c.next().unwrap().to_uppercase().collect::<String>() + &c.as_str().to_ascii_lowercase()
        })
        .collect()
}
pub fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}
pub fn resource(r: &Resolve, mut ty: Type) -> Option<TypeId> {
    loop {
        let Type::Id(id) = ty else { return None };
        match r.types[id].kind {
            TypeDefKind::Type(t) => ty = t,
            TypeDefKind::Handle(Handle::Borrow(t) | Handle::Own(t)) => ty = Type::Id(t),
            TypeDefKind::Resource => return Some(id),
            _ => return None,
        }
    }
}
pub fn collect(
    r: &Resolve,
    world: WorldId,
) -> Result<BTreeMap<TypeId, GuestResource>, Box<dyn Error>> {
    let mut result = BTreeMap::new();
    for (key, item) in &r.worlds[world].exports {
        let WorldItem::Interface { id, .. } = item else {
            continue;
        };
        let interface = &r.interfaces[*id];
        let namespace = match key {
            WorldKey::Name(n) => n.clone(),
            _ => interface.name.clone().ok_or("unnamed interface")?,
        };
        if namespace == "taraba-guest-resources" {
            for f in interface.functions.values() {
                let (ns, name) = f
                    .name
                    .strip_prefix("guest-")
                    .and_then(|s| s.split_once('-'))
                    .ok_or("invalid guest resource metadata")?;
                let id = resource(r, f.params.first().ok_or("missing guest resource type")?.ty)
                    .ok_or("invalid guest resource type")?;
                result.insert(
                    id,
                    GuestResource {
                        namespace: crate::interfaces::unhex(ns)?,
                        name: crate::interfaces::unhex(name)?,
                    },
                );
            }
        } else {
            for (name, id) in &interface.types {
                if matches!(r.types[*id].kind, TypeDefKind::Resource) {
                    if result
                        .insert(
                            *id,
                            GuestResource {
                                namespace: namespace.clone(),
                                name: name.clone(),
                            },
                        )
                        .is_some()
                    {
                        return Err(
                            "Core exported resource interfaces currently require one export alias"
                                .into(),
                        );
                    }
                }
            }
        }
    }
    Ok(result)
}
