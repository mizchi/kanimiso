//! Build-time handshake for the private Rust/JS runtime, independent of SemVer.
use std::error::Error;

const REVISION: u32 = 1;
const SECTION: &str = "taraba:runtime-abi";
pub(crate) fn validate(bytes: &[u8]) -> Result<Option<u32>, Box<dyn Error>> {
    let mut revision = None;
    let mut required = false;
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        match payload? {
            wasmparser::Payload::CustomSection(section) if section.name() == SECTION => {
                if revision.is_some() {
                    return Err(
                        "duplicate taraba runtime ABI metadata; link exactly one runtime".into(),
                    );
                }
                let data: [u8; 4] = section
                    .data()
                    .try_into()
                    .map_err(|_| "invalid taraba runtime ABI metadata")?;
                let found = u32::from_le_bytes(data) >> 16;
                if found != REVISION {
                    return Err(format!("taraba runtime ABI {found} is incompatible with CLI ABI {REVISION}; rebuild with matching taraba Rust runtime and CLI").into());
                }
                revision = Some(found);
            }
            wasmparser::Payload::ImportSection(imports) => {
                for import in imports.into_imports() {
                    required |= matches!(import?.module, "jsrt" | "pool");
                }
            }
            wasmparser::Payload::ExportSection(exports) => {
                for export in exports {
                    required |= matches!(export?.name, "rt_poll" | "rt_drop" | "rt_settle");
                }
            }
            _ => {}
        }
    }
    if required && revision.is_none() {
        return Err("missing taraba runtime ABI metadata; rebuild the raw Wasm with the matching Rust runtime and export_runtime!() (updating the CLI alone does not update Cargo dependencies)".into());
    }
    Ok(revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn module(revisions: &[&[u8]], runtime: bool) -> Vec<u8> {
        let mut m = walrus::Module::from_buffer(
            &wat::parse_str(if runtime {
                "(module (func (export \"rt_poll\")))"
            } else {
                "(module)"
            })
            .unwrap(),
        )
        .unwrap();
        for revision in revisions {
            m.customs.add(walrus::RawCustomSection {
                name: "taraba:runtime-abi".into(),
                data: revision.to_vec(),
            });
        }
        m.emit_wasm()
    }
    #[test]
    fn rejects_old_new_malformed_and_duplicate_runtime_metadata() {
        assert!(
            validate(&module(&[], true))
                .unwrap_err()
                .to_string()
                .contains("runtime ABI")
        );
        for sections in [
            vec![&(2u32 << 16).to_le_bytes()[..]],
            vec![&[1, 0][..]],
            vec![
                &(1u32 << 16).to_le_bytes()[..],
                &(1u32 << 16).to_le_bytes()[..],
            ],
        ] {
            assert!(validate(&module(&sections, true)).is_err());
        }
        assert_eq!(
            validate(&module(&[&(1u32 << 16).to_le_bytes()], true)).unwrap(),
            Some(1)
        );
        assert_eq!(validate(&module(&[], false)).unwrap(), None);
    }
    #[test]
    fn runtime_imports_require_metadata_even_without_exported_tasks() {
        for namespace in ["pool", "jsrt"] {
            let raw = wat::parse_str(format!(
                "(module (import \"{namespace}\" \"allocate\" (func)))"
            ))
            .unwrap();
            assert!(validate(&raw).is_err());
        }
    }
}
