//! Patch only the import section; preserve executable/custom sections byte for byte.
use std::{collections::BTreeMap, error::Error};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
fn uint(bytes: &[u8], p: &mut usize) -> Result<u32> {
    let mut n = 0u32;
    for i in 0..5 {
        let x = *bytes.get(*p).ok_or("truncated LEB")?;
        *p += 1;
        if i == 4 && x > 15 {
            return Err("invalid u32 LEB".into());
        }
        n |= u32::from(x & 127) << (i * 7);
        if x & 128 == 0 {
            return Ok(n);
        }
    }
    Err("invalid u32 LEB".into())
}
fn leb(mut n: u32, out: &mut Vec<u8>) {
    loop {
        let x = (n & 127) as u8;
        n >>= 7;
        out.push(x | if n > 0 { 128 } else { 0 });
        if n == 0 {
            break;
        }
    }
}
fn string(bytes: &[u8], p: &mut usize) -> Result<String> {
    let n = uint(bytes, p)? as usize;
    let end = p.checked_add(n).ok_or("string overflow")?;
    let s = std::str::from_utf8(bytes.get(*p..end).ok_or("truncated string")?)?.to_string();
    *p = end;
    Ok(s)
}
fn write_string(s: &str, out: &mut Vec<u8>) {
    leb(s.len() as u32, out);
    out.extend_from_slice(s.as_bytes())
}
pub(crate) fn rename(bytes: &[u8], names: &BTreeMap<String, String>) -> Result<Vec<u8>> {
    rename_in(bytes, Some("jsrt"), names)
}
pub(crate) fn rename_app(bytes: &[u8], names: &BTreeMap<String, String>) -> Result<Vec<u8>> {
    rename_in(bytes, Some("app"), names)
}
pub(crate) fn rename_exports(bytes: &[u8], names: &BTreeMap<String, String>) -> Result<Vec<u8>> {
    rename_in(bytes, None, names)
}
fn rename_in(
    bytes: &[u8],
    target: Option<&str>,
    names: &BTreeMap<String, String>,
) -> Result<Vec<u8>> {
    if bytes.get(..8) != Some(b"\0asm\x01\0\0\0") {
        return Err("expected Core Wasm v1".into());
    }
    let mut out = bytes[..8].to_vec();
    let mut p = 8;
    while p < bytes.len() {
        let start = p;
        let id = bytes[p];
        p += 1;
        let size = uint(bytes, &mut p)? as usize;
        let end = p.checked_add(size).ok_or("section overflow")?;
        let section = bytes.get(p..end).ok_or("truncated section")?;
        if target.is_none() && id == 7 {
            let mut q = 0;
            let count = uint(section, &mut q)?;
            let mut body = Vec::new();
            leb(count, &mut body);
            for _ in 0..count {
                let name = string(section, &mut q)?;
                let start = q;
                let kind = *section.get(q).ok_or("missing export kind")?;
                q += 1;
                uint(section, &mut q)?;
                write_string(
                    if kind == 0 {
                        names.get(&name).unwrap_or(&name)
                    } else {
                        &name
                    },
                    &mut body,
                );
                body.extend_from_slice(&section[start..q]);
            }
            if q != section.len() {
                return Err("trailing export bytes".into());
            }
            out.push(7);
            leb(body.len() as u32, &mut out);
            out.extend(body);
            p = end;
            continue;
        }
        if id != 2 || target.is_none() {
            out.extend_from_slice(&bytes[start..end]);
            p = end;
            continue;
        }
        let mut q = 0;
        let count = uint(section, &mut q)?;
        let mut body = Vec::new();
        leb(count, &mut body);
        for _ in 0..count {
            let module = string(section, &mut q)?;
            let name = string(section, &mut q)?;
            let descriptor = q;
            let kind = *section.get(q).ok_or("missing import kind")?;
            q += 1;
            match kind {
                0 => {
                    uint(section, &mut q)?;
                }
                1 => {
                    if section.get(q) != Some(&0x6f) {
                        return Err("expected externref table".into());
                    }
                    q += 1;
                    let flags = uint(section, &mut q)?;
                    if flags > 1 {
                        return Err("unsupported table limits".into());
                    }
                    uint(section, &mut q)?;
                    if flags == 1 {
                        uint(section, &mut q)?;
                    }
                }
                _ => return Err("unsupported import kind".into()),
            }
            write_string(&module, &mut body);
            let renamed = if target == Some(module.as_str()) && kind == 0 {
                names.get(&name).unwrap_or(&name)
            } else {
                &name
            };
            if renamed.is_empty() {
                return Err("empty import name".into());
            }
            write_string(renamed, &mut body);
            body.extend_from_slice(&section[descriptor..q]);
        }
        if q != section.len() {
            return Err("trailing import bytes".into());
        }
        out.push(2);
        leb(body.len() as u32, &mut out);
        out.extend(body);
        p = end;
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_export_names_preserve_imports_and_instructions() {
        let input=wat::parse_str(r#"(module (import "$exports" "taraba-iface-61-run" (func)) (func (export "taraba-iface-61-run") (result i32) i32.const 42) (func (export "user")))"#).unwrap();
        let short = rename_exports(
            &input,
            &BTreeMap::from([("taraba-iface-61-run".into(), "a".into())]),
        )
        .unwrap();
        assert!(
            walrus::Module::from_buffer(&short)
                .unwrap()
                .imports
                .get_func("$exports", "taraba-iface-61-run")
                .is_ok()
        );
        assert!(
            walrus::Module::from_buffer(&short)
                .unwrap()
                .exports
                .iter()
                .any(|e| e.name == "a")
        );
        assert_eq!(
            rename_exports(
                &short,
                &BTreeMap::from([("a".into(), "taraba-iface-61-run".into())])
            )
            .unwrap(),
            input
        );
    }
    #[test]
    fn private_app_names_preserve_other_sections_and_user_imports() {
        let input = wat::parse_str(r#"(module (import "app" "taraba-codec-12-copy" (func $copy)) (import "app" "user" (func)) (import "jsrt" "number" (func)) (func (export "run") call $copy))"#).unwrap();
        let names = BTreeMap::from([("taraba-codec-12-copy".into(), "a".into())]);
        let short = rename_app(&input, &names).unwrap();
        let m = walrus::Module::from_buffer(&short).unwrap();
        assert!(m.imports.get_func("app", "a").is_ok());
        assert!(m.imports.get_func("app", "user").is_ok());
        assert!(m.imports.get_func("jsrt", "number").is_ok());
        assert_eq!(
            rename_app(
                &short,
                &BTreeMap::from([("a".into(), "taraba-codec-12-copy".into())])
            )
            .unwrap(),
            input
        );
    }
    #[test]
    fn patch_preserves_code_and_rejects_truncation() {
        let input=wat::parse_str(r#"(module (import "jsrt" "number" (func $n (param i32) (result i32))) (func (export "x") (result i32) i32.const 42 call $n))"#).unwrap();
        let names = BTreeMap::from([("number".into(), "n".into())]);
        let out = rename(&input, &names).unwrap();
        let m = walrus::Module::from_buffer(&out).unwrap();
        assert!(m.imports.get_func("jsrt", "n").is_ok());
        let back = rename(&out, &BTreeMap::from([("n".into(), "number".into())])).unwrap();
        assert_eq!(input, back);
        assert!(rename(&input[..7], &names).is_err());
        assert!(rename(&input[..input.len() - 1], &names).is_err());
        assert!(rename(&[0, 97, 115, 109, 1, 0, 0, 0, 2, 1, 128], &names).is_err());
    }
}
