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
        if id != 2 {
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
            let renamed = if module == "jsrt" && kind == 0 {
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
