//! Advisory source hints. They are not macro expansion or a byte attribution.
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use syn::{Attribute, Meta, visit::Visit};

#[derive(Default)]
pub struct Config {
    pub features: BTreeSet<String>,
    pub debug_assertions: bool,
}

fn dependency_hints(data: &serde_json::Value, selected: &str) -> Vec<(String, &'static str)> {
    let mut pending = vec![selected.to_owned()];
    let mut reachable = BTreeSet::new();
    let nodes = data["resolve"]["nodes"].as_array();
    while let Some(id) = pending.pop() {
        if !reachable.insert(id.clone()) {
            continue;
        }
        if let Some(node) = nodes.and_then(|ns| ns.iter().find(|n| n["id"] == id)) {
            for dep in node["deps"].as_array().into_iter().flatten() {
                if dep["dep_kinds"]
                    .as_array()
                    .is_some_and(|kinds| kinds.iter().any(|k| k["kind"].is_null()))
                {
                    if let Some(id) = dep["pkg"].as_str() {
                        pending.push(id.to_owned());
                    }
                }
            }
        }
    }
    let mut hints = std::collections::BTreeMap::new();
    for p in data["packages"].as_array().into_iter().flatten() {
        if !p["id"].as_str().is_some_and(|id| reachable.contains(id)) {
            continue;
        }
        let Some(name) = p["name"].as_str() else {
            continue;
        };
        let hint = match name {
            "regex" | "regex-lite" => {
                "pattern engines and Unicode tables; consider taraba_helpers::regexp::RegExp when JavaScript regex semantics are acceptable"
            }
            "serde_json" => {
                "parser, serializer and number formatting; JS JSON is a candidate only when number precision and schema/ownership semantics permit (helper not yet implemented)"
            }
            "url" | "idna" => {
                "URL parsing / IDNA Unicode tables; JS URL is a candidate (helper not yet implemented)"
            }
            "chrono" | "time" => {
                "date/time parsing and formatting; JS Date/Intl may cover a restricted contract (helper not yet implemented)"
            }
            "unicode-normalization" => {
                "Unicode normalization tables; consider taraba_helpers::string::JsString::normalize when host Unicode semantics are acceptable"
            }
            "unicode-segmentation" => {
                "Unicode boundary tables; consider taraba_helpers::segmenter::Segmenter with explicit locale and host Unicode semantics"
            }
            "tokio" | "async-std" | "rayon" => {
                "executor, synchronization or thread support; check whether the JS event loop and taraba's async contract cover this use"
            }
            _ => continue,
        };
        hints.insert(name.to_owned(), hint);
    }
    hints.into_iter().collect()
}
pub fn warn_dependencies(data: &serde_json::Value, selected: &str) {
    for (name, hint) in dependency_hints(data, selected) {
        eprintln!(
            "warning[taraba::host-builtin]: {name}: {hint}. Dependency presence is only a candidate, not proof of retained bytes; use taraba build --insight and taraba insight. See https://github.com/mizchi/taraba/blob/main/docs/helpers.ja.md."
        );
    }
}
#[derive(Debug, PartialEq, Eq)]
struct Hint {
    line: usize,
    column: usize,
    name: String,
}
fn predicate(meta: &Meta, cfg: &Config) -> Option<bool> {
    match meta {
        Meta::Path(p) if p.is_ident("test") => Some(false),
        Meta::Path(p) if p.is_ident("debug_assertions") => Some(cfg.debug_assertions),
        Meta::NameValue(n) => {
            let syn::Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(value),
                ..
            }) = &n.value
            else {
                return None;
            };
            let key = n.path.get_ident()?.to_string();
            Some(match key.as_str() {
                "feature" => cfg.features.contains(&value.value()),
                "target_arch" => value.value() == "wasm32",
                "target_os" => value.value() == "unknown",
                "target_family" => value.value() == "wasm",
                "target_pointer_width" => value.value() == "32",
                _ => return None,
            })
        }
        Meta::List(l) => {
            let args = l
                .parse_args_with(
                    syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated,
                )
                .ok()?;
            let values: Vec<_> = args.iter().map(|m| predicate(m, cfg)).collect();
            if l.path.is_ident("not") && values.len() == 1 {
                values[0].map(|v| !v)
            } else if l.path.is_ident("all") {
                if values.contains(&Some(false)) {
                    Some(false)
                } else if values.iter().all(|v| *v == Some(true)) {
                    Some(true)
                } else {
                    None
                }
            } else if l.path.is_ident("any") {
                if values.contains(&Some(true)) {
                    Some(true)
                } else if values.iter().all(|v| *v == Some(false)) {
                    Some(false)
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    }
}
fn enabled(attrs: &[Attribute], cfg: &Config) -> bool {
    if attrs
        .iter()
        .any(|a| a.path().is_ident("test") || a.path().is_ident("bench"))
    {
        return false;
    }
    attrs
        .iter()
        .filter(|a| a.path().is_ident("cfg"))
        .all(|a| a.parse_args::<Meta>().ok().and_then(|m| predicate(&m, cfg)) != Some(false))
}
fn hints(source: &str, cfg: &Config) -> syn::Result<Vec<Hint>> {
    struct Scanner<'a> {
        cfg: &'a Config,
        hints: Vec<Hint>,
    }
    impl<'ast> Visit<'ast> for Scanner<'_> {
        fn visit_macro(&mut self, m: &'ast syn::Macro) {
            let Some(name) = m.path.segments.last().map(|s| &s.ident) else {
                return;
            };
            if [
                "fmt",
                "format",
                "format_args",
                "format_args_nl",
                "write",
                "writeln",
                "print",
                "println",
                "eprint",
                "eprintln",
                "dbg",
            ]
            .iter()
            .any(|n| name == n)
            {
                let start = name.span().start();
                self.hints.push(Hint {
                    line: start.line,
                    column: start.column + 1,
                    name: name.to_string(),
                });
            }
        }
        fn visit_item_mod(&mut self, v: &'ast syn::ItemMod) {
            if enabled(&v.attrs, self.cfg) {
                syn::visit::visit_item_mod(self, v);
            }
        }
        fn visit_item_fn(&mut self, v: &'ast syn::ItemFn) {
            if enabled(&v.attrs, self.cfg) {
                syn::visit::visit_item_fn(self, v);
            }
        }
        fn visit_item_impl(&mut self, v: &'ast syn::ItemImpl) {
            if enabled(&v.attrs, self.cfg) {
                syn::visit::visit_item_impl(self, v);
            }
        }
        fn visit_impl_item_fn(&mut self, v: &'ast syn::ImplItemFn) {
            if enabled(&v.attrs, self.cfg) {
                syn::visit::visit_impl_item_fn(self, v);
            }
        }
        fn visit_trait_item_fn(&mut self, v: &'ast syn::TraitItemFn) {
            if enabled(&v.attrs, self.cfg) {
                syn::visit::visit_trait_item_fn(self, v);
            }
        }
        fn visit_expr_block(&mut self, v: &'ast syn::ExprBlock) {
            if enabled(&v.attrs, self.cfg) {
                syn::visit::visit_expr_block(self, v);
            }
        }
        fn visit_expr_macro(&mut self, v: &'ast syn::ExprMacro) {
            if enabled(&v.attrs, self.cfg) {
                syn::visit::visit_expr_macro(self, v);
            }
        }
        fn visit_stmt_macro(&mut self, v: &'ast syn::StmtMacro) {
            if enabled(&v.attrs, self.cfg) {
                syn::visit::visit_stmt_macro(self, v);
            }
        }
    }
    let file = syn::parse_file(source)?;
    let mut scanner = Scanner {
        cfg,
        hints: Vec::new(),
    };
    scanner.visit_file(&file);
    Ok(scanner.hints)
}

// Cargo dep-info uses Make escaping. Read only the first (artifact) rule.
fn dep_sources(text: &str) -> Vec<PathBuf> {
    let joined = text.replace("\\\r\n", "").replace("\\\n", "");
    let first = joined.lines().next().unwrap_or("");
    let mut escaped = false;
    let mut start = None;
    for (i, c) in first.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == ':' && first[i + 1..].starts_with(char::is_whitespace) {
            start = Some(i + 1);
            break;
        }
    }
    let Some(start) = start else {
        return Vec::new();
    };
    let mut result = Vec::new();
    let mut token = String::new();
    let mut chars = first[start..].chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(c) = chars.next() {
                token.push(c);
            }
        } else if c == '$' && chars.peek() == Some(&'$') {
            chars.next();
            token.push('$');
        } else if c.is_whitespace() {
            if !token.is_empty() {
                result.push(PathBuf::from(std::mem::take(&mut token)));
            }
        } else {
            token.push(c);
        }
    }
    if !token.is_empty() {
        result.push(token.into());
    }
    result
}
pub fn warn_sources(wasm: &Path, source_root: &Path, cfg: &Config) {
    let Ok(depfile) = fs::read_to_string(wasm.with_extension("d")) else {
        return;
    };
    let mut files = dep_sources(&depfile);
    files.sort();
    files.dedup();
    let mut count = 0;
    for path in files
        .into_iter()
        .filter(|p| p.starts_with(source_root) && p.extension().is_some_and(|s| s == "rs"))
    {
        let found = fs::read_to_string(&path)
            .ok()
            .and_then(|s| hints(&s, cfg).ok());
        if let Some(found) = found {
            for hint in found {
                if count < 20 {
                    eprintln!(
                        "warning[taraba::fmt-size]: {}:{}:{}: {}! may retain formatting code and increase Wasm size; inspect with taraba build --insight and taraba insight --paths fmt",
                        path.display(),
                        hint.line,
                        hint.column,
                        hint.name
                    );
                }
                count += 1;
            }
        }
    }
    if count > 20 {
        eprintln!(
            "warning[taraba::fmt-size]: {} additional formatting sites omitted",
            count - 20
        );
    }
}
pub fn warn_wasm(path: &Path) {
    if let Ok((count, bytes)) = fs::read(path)
        .map_err(|e| e.to_string())
        .and_then(|b| taraba_cli::insight::formatting_summary(&b).map_err(|e| e.to_string()))
    {
        if count > 0 {
            eprintln!(
                "warning[taraba::fmt-linked]: {count} formatting functions occupy {bytes} B in the input Wasm before wasm-opt. This is not predicted size growth; use taraba build --insight, then taraba insight --paths fmt for optimized attribution."
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dependency_candidates_follow_only_selected_normal_edges() {
        let data = serde_json::json!({
            "packages": [
                {"id":"app","name":"app"},
                {"id":"regex","name":"regex"},
                {"id":"json","name":"serde_json"},
                {"id":"url","name":"url"}
            ],
            "resolve":{"nodes":[
                {"id":"app","deps":[
                    {"pkg":"regex","dep_kinds":[{"kind":null}]},
                    {"pkg":"json","dep_kinds":[{"kind":"dev"}]},
                    {"pkg":"url","dep_kinds":[{"kind":"build"}]}
                ]},
                {"id":"regex","deps":[]}
            ]}
        });
        let found = dependency_hints(&data, "app");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "regex");
        assert!(found[0].1.contains("taraba_helpers::regexp::RegExp"));
    }
    #[test]
    fn rust_syntax_ignores_comments_strings_and_disabled_test_debug_feature_blocks() {
        let source = r##"// format!("comment")
fn app() {
    let _="write!(fake)";
    let _=r#"format!(raw)"#;
    let _=alloc::format!("{n}");
    write!(output,"{n}");
    #[cfg(debug_assertions)] { println!("debug"); }
}
#[cfg(test)] mod tests {fn x(){format!("test");}}
#[test] fn isolated_test(){format!("not compiled");}
#[cfg(feature="extra")] fn extra(){writeln!(output,"extra");}
"##;
        let cfg = Config::default();
        let found = hints(source, &cfg).unwrap();
        assert_eq!(
            found.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(),
            ["format", "write"]
        );
        assert_eq!(found[0].line, 5);
        let cfg = Config {
            features: BTreeSet::from(["extra".into()]),
            debug_assertions: true,
        };
        assert_eq!(hints(source, &cfg).unwrap().len(), 4);
    }
    #[test]
    fn dep_info_handles_spaces_backslashes_dollars_and_line_continuations() {
        assert_eq!(
            dep_sources(
                "target\\ file.wasm: /a/src/lib.rs /with\\ space/a.rs \\\n/dollar$$/b.rs /back\\\\slash/c.rs\n/a/src/lib.rs:\n"
            ),
            vec![
                PathBuf::from("/a/src/lib.rs"),
                PathBuf::from("/with space/a.rs"),
                PathBuf::from("/dollar$/b.rs"),
                PathBuf::from("/back\\slash/c.rs")
            ]
        );
    }
}
