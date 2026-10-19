//! Read-only Core Wasm size inspection. Modern wasmparser decoding feeds twiggy's
//! IR/dominator analysis; twiggy's older binary parser is deliberately not used.
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use twiggy_ir::{Code, Id, Item, Items, ItemsBuilder, Misc};
use wasmparser::{Encoding, ExternalKind, KnownCustom, Name, Operator, Parser, Payload, TypeRef};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// A byte range including its section ID and length prefix.
#[derive(Debug)]
pub struct Section {
    pub id: u8,
    pub name: String,
    pub bytes: usize,
}
/// Function sizes include the body's length prefix, locals and instructions.
#[derive(Debug)]
pub struct Function {
    pub index: u32,
    pub name: String,
    pub shallow_bytes: u32,
    /// Dominated function bytes only, not an estimate of removable artifact bytes.
    pub retained_bytes: Option<u32>,
    pub group: &'static str,
}
/// The graph is conservative: element/global/table references are roots and
/// indirect call destinations are not inferred from runtime state.
pub struct Report {
    pub total_bytes: usize,
    pub sections: Vec<Section>,
    pub functions: Vec<Function>,
    pub named_functions: usize,
    pub indirect_calls: usize,
    graph: Items,
    parents: BTreeMap<Id, Id>,
}

fn id(index: u32) -> Id {
    Id::entry(1, index as usize)
}
fn group(name: &str) -> &'static str {
    let normalized = name
        .split('[')
        .enumerate()
        .map(|(i, s)| {
            if i == 0 {
                s
            } else {
                s.split_once(']').map_or(s, |(_, s)| s)
            }
        })
        .collect::<String>();
    if normalized.contains("core::fmt::") || normalized.contains("std::fmt::") {
        "formatting"
    } else if normalized.contains("::panicking::") || normalized.contains("rust_begin_unwind") {
        "panic"
    } else if normalized.contains("taraba_allocator")
        || normalized.contains("wee_alloc")
        || normalized.contains("alloc::alloc::")
    {
        "allocator"
    } else if [
        "regex::",
        "regex_automata::",
        "regex_syntax::",
        "regex_lite::",
    ]
    .iter()
    .any(|p| normalized.contains(p))
    {
        "regex"
    } else if normalized.contains("serde_json::") {
        "json"
    } else if normalized.contains("unicode_normalization::")
        || normalized.contains("unicode_segmentation::")
    {
        "unicode"
    } else if ["url::", "idna::", "icu_"]
        .iter()
        .any(|p| normalized.contains(p))
    {
        "url-unicode"
    } else if ["chrono::", "time::"]
        .iter()
        .any(|p| normalized.contains(p))
    {
        "date-time"
    } else if [
        "hashbrown::",
        "std::collections::hash::",
        "alloc::collections::btree::",
    ]
    .iter()
    .any(|p| normalized.contains(p))
    {
        "collections"
    } else if ["tokio::", "async_std::", "rayon::"]
        .iter()
        .any(|p| normalized.contains(p))
    {
        "executor"
    } else {
        "other"
    }
}
fn references(reader: wasmparser::OperatorsReader<'_>, roots: &mut BTreeSet<u32>) -> Result<()> {
    for op in reader {
        if let Operator::RefFunc { function_index } = op? {
            roots.insert(function_index);
        }
    }
    Ok(())
}

/// Validate and inspect a Core module without rewriting any byte.
pub fn analyze(bytes: &[u8]) -> Result<Report> {
    if !Parser::is_core_wasm(bytes) {
        return Err(
            "insight expects a Core Wasm module; inspect a component's extracted Core modules"
                .into(),
        );
    }
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(bytes)?;
    let mut sections = Vec::new();
    let (mut end, mut body_end) = (8, 0);
    let mut names = BTreeMap::new();
    let mut imports = Vec::new();
    let mut bodies = Vec::new();
    let mut edges = Vec::new();
    let mut exports = Vec::new();
    let mut referenced = BTreeSet::new();
    let mut indirect_calls = 0;
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload?;
        if let Some((section, range)) = payload.as_section() {
            let name = if let Payload::CustomSection(ref s) = payload {
                s.name().to_owned()
            } else {
                match section {
                    1 => "type",
                    2 => "import",
                    3 => "function",
                    4 => "table",
                    5 => "memory",
                    6 => "global",
                    7 => "export",
                    8 => "start",
                    9 => "element",
                    10 => "code",
                    11 => "data",
                    12 => "data-count",
                    13 => "tag",
                    _ => "unknown",
                }
                .to_owned()
            };
            sections.push(Section {
                id: section,
                name,
                bytes: range.end - end,
            });
            end = range.end;
        }
        match payload {
            Payload::Version {
                encoding: Encoding::Component,
                ..
            } => return Err("insight expects Core Wasm".into()),
            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    let i = import?;
                    if matches!(i.ty, TypeRef::Func(_) | TypeRef::FuncExact(_)) {
                        imports.push(format!("import {}.{}", i.module, i.name));
                    }
                }
            }
            Payload::ExportSection(reader) => {
                for e in reader {
                    let e = e?;
                    if matches!(e.kind, ExternalKind::Func | ExternalKind::FuncExact) {
                        exports.push((format!("export {}", e.name), e.index));
                    }
                }
            }
            Payload::StartSection { func, .. } => exports.push(("start".into(), func)),
            Payload::ElementSection(reader) => {
                for e in reader {
                    match e?.items {
                        wasmparser::ElementItems::Functions(fs) => {
                            for f in fs {
                                referenced.insert(f?);
                            }
                        }
                        wasmparser::ElementItems::Expressions(_, exprs) => {
                            for expr in exprs {
                                references(expr?.get_operators_reader(), &mut referenced)?;
                            }
                        }
                    }
                }
            }
            Payload::GlobalSection(reader) => {
                for g in reader {
                    references(g?.init_expr.get_operators_reader(), &mut referenced)?;
                }
            }
            Payload::TableSection(reader) => {
                for t in reader {
                    if let wasmparser::TableInit::Expr(expr) = t?.init {
                        references(expr.get_operators_reader(), &mut referenced)?;
                    }
                }
            }
            Payload::CodeSectionStart { range, .. } => {
                // Count LEBs need not use their shortest encoding in a valid module.
                let mut reader = wasmparser::BinaryReader::new(&bytes[range.clone()], range.start);
                reader.read_var_u32()?;
                body_end = reader.original_position();
            }
            Payload::CodeSectionEntry(body) => {
                let index = imports.len() as u32 + bodies.len() as u32;
                bodies.push((index, u32::try_from(body.range().end - body_end)?));
                body_end = body.range().end;
                for op in body.get_operators_reader()? {
                    match op? {
                        Operator::Call { function_index }
                        | Operator::ReturnCall { function_index }
                        | Operator::RefFunc { function_index } => {
                            edges.push((index, function_index))
                        }
                        Operator::CallIndirect { .. }
                        | Operator::ReturnCallIndirect { .. }
                        | Operator::CallRef { .. }
                        | Operator::ReturnCallRef { .. } => indirect_calls += 1,
                        _ => {}
                    }
                }
            }
            Payload::CustomSection(reader) => {
                if let KnownCustom::Name(reader) = reader.as_known() {
                    for name in reader {
                        if let Name::Function(map) = name? {
                            for name in map {
                                let name = name?;
                                names.insert(name.index, name.name.to_owned());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let named_functions = bodies.iter().filter(|(i, _)| names.contains_key(i)).count();
    let mut builder = ItemsBuilder::new(u32::try_from(bytes.len())?);
    for (i, name) in imports.into_iter().enumerate() {
        builder.add_item(Item::new(id(i as u32), name, 0, Misc::new()));
    }
    // Export labels remain useful when the optional name section is stripped.
    let labels: BTreeMap<_, _> = exports
        .iter()
        .map(|(label, i)| {
            (
                *i,
                label.strip_prefix("export ").unwrap_or(label).to_owned(),
            )
        })
        .collect();
    for &(index, size) in &bodies {
        let name = names
            .get(&index)
            .cloned()
            .or_else(|| labels.get(&index).cloned())
            .unwrap_or_else(|| format!("function[{index}]"));
        let code = Code::new(&name);
        builder.add_item(Item::new(id(index), name, size, code));
    }
    for (i, (label, function)) in exports.iter().enumerate() {
        let root = Id::entry(2, i);
        builder.add_root(Item::new(root, label, 0, Misc::new()));
        builder.add_edge(root, id(*function));
    }
    if !referenced.is_empty() {
        let root = Id::section(3);
        builder.add_root(Item::new(
            root,
            "table/global function references",
            0,
            Misc::new(),
        ));
        for function in referenced {
            builder.add_edge(root, id(function));
        }
    }
    for (from, to) in edges {
        builder.add_edge(id(from), id(to));
    }
    let mut graph = builder.finish();
    graph.compute_dominators();
    // Sum the dominator tree iteratively to avoid recursive traversal of large modules.
    let mut children: BTreeMap<Id, Vec<Id>> = BTreeMap::new();
    for (&child, &parent) in graph.immediate_dominators() {
        children.entry(parent).or_default().push(child);
    }
    let mut order = vec![graph.meta_root()];
    let mut cursor = 0;
    while cursor < order.len() {
        if let Some(cs) = children.get(&order[cursor]) {
            order.extend(cs);
        }
        cursor += 1;
    }
    let mut retained: BTreeMap<_, u32> = graph.iter().map(|i| (i.id(), i.size())).collect();
    for node in order.into_iter().rev() {
        if let Some(parent) = graph.immediate_dominators().get(&node) {
            *retained.get_mut(parent).unwrap() += retained[&node];
        }
    }
    let mut parents = BTreeMap::new();
    let mut queue = VecDeque::from([graph.meta_root()]);
    let mut seen = BTreeSet::from([graph.meta_root()]);
    while let Some(node) = queue.pop_front() {
        for next in graph.neighbors(node) {
            if seen.insert(next) {
                parents.insert(next, node);
                queue.push_back(next);
            }
        }
    }
    let functions = bodies
        .into_iter()
        .map(|(index, shallow_bytes)| {
            let name = graph[id(index)].name().to_owned();
            Function {
                index,
                shallow_bytes,
                retained_bytes: seen.contains(&id(index)).then(|| retained[&id(index)]),
                group: group(&name),
                name,
            }
        })
        .collect();
    Ok(Report {
        total_bytes: bytes.len(),
        sections,
        functions,
        named_functions,
        indirect_calls,
        graph,
        parents,
    })
}

/// Remove only the optional function-name metadata, preserving every other byte.
pub fn strip_names(bytes: &[u8]) -> Result<Vec<u8>> {
    if !Parser::is_core_wasm(bytes) {
        return Err("expected Core Wasm".into());
    }
    let mut out = bytes[..8].to_vec();
    let mut end = 8;
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload?;
        if let Some((_, range)) = payload.as_section() {
            if !matches!(payload,Payload::CustomSection(ref s) if s.name()=="name") {
                out.extend_from_slice(&bytes[end..range.end]);
            }
            end = range.end;
        }
    }
    Ok(out)
}

impl Report {
    /// One shortest root-to-function path; other keeping paths may exist.
    pub fn path(&self, index: u32) -> Vec<String> {
        if index == u32::MAX || !self.parents.contains_key(&id(index)) {
            return Vec::new();
        }
        let mut current = id(index);
        let mut path = Vec::new();
        while current != self.graph.meta_root() {
            path.push(self.graph[current].name().to_owned());
            let Some(parent) = self.parents.get(&current) else {
                return Vec::new();
            };
            current = *parent;
        }
        path.reverse();
        path
    }
    /// Sum disjoint physical function bodies tagged as formatting, not retained bytes.
    pub fn formatting(&self) -> (usize, u32) {
        self.functions
            .iter()
            .filter(|f| f.group == "formatting")
            .fold((0, 0), |(n, b), f| (n + 1, b + f.shallow_bytes))
    }
    /// Produce a deterministic view. The underlying analysis always covers all functions.
    pub fn json(
        &self,
        top: usize,
        filter: Option<&str>,
        retained: bool,
        paths: bool,
    ) -> serde_json::Value {
        let mut functions: Vec<_> = self
            .functions
            .iter()
            .filter(|f| filter.is_none_or(|s| f.name.contains(s)))
            .collect();
        functions.sort_by_key(|f| {
            (
                std::cmp::Reverse(if retained {
                    f.retained_bytes.unwrap_or(0)
                } else {
                    f.shallow_bytes
                }),
                f.index,
            )
        });
        let matched = functions.len();
        functions.truncate(top);
        let mut notes = vec![
            "Retained bytes cover dominated function bodies only, excluding data, types and other sections; they are not predicted size savings.",
        ];
        if self.named_functions < self.functions.len() {
            notes.push("Some function names are absent. Use taraba build --insight with Cargo strip=false to retain an optimized analysis view.");
        }
        if self.indirect_calls > 0 {
            notes.push("Indirect dispatch is present. Table/global references are conservative roots; runtime call targets are not inferred.");
        }
        let mut groups: BTreeMap<&str, u64> = BTreeMap::new();
        for f in &self.functions {
            *groups.entry(f.group).or_default() += u64::from(f.shallow_bytes);
        }
        serde_json::json!({"schema":1,"engine":"wasmparser 0.252.0 + twiggy-ir 0.8.0","total_bytes":self.total_bytes,
            "name_bytes":self.sections.iter().filter(|s|s.id==0&&s.name=="name").map(|s|s.bytes).sum::<usize>(),
            "sections":self.sections.iter().map(|s|serde_json::json!({"id":s.id,"name":s.name,"bytes":s.bytes})).collect::<Vec<_>>(),
            "function_count":self.functions.len(),"named_functions":self.named_functions,"matched_functions":matched,"indirect_calls":self.indirect_calls,
            "groups":groups,"notes":notes,"functions":functions.into_iter().map(|f|{
                let mut row=serde_json::json!({"index":f.index,"name":f.name,"shallow_bytes":f.shallow_bytes,"retained_bytes":f.retained_bytes,"group":f.group});
                if paths {row["path"]=self.path(f.index).into();}row
            }).collect::<Vec<_>>()})
    }
}

/// Fast, advisory formatting totals from names and encoded bodies. This avoids
/// constructing a dominator graph during every ordinary build.
pub fn formatting_summary(bytes: &[u8]) -> Result<(usize, u32)> {
    if !Parser::is_core_wasm(bytes) {
        return Err("expected Core Wasm".into());
    }
    let mut names = BTreeMap::new();
    let mut sizes = Vec::new();
    let mut imports = 0u32;
    let mut end = 0;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::ImportSection(reader) => {
                for i in reader.into_imports() {
                    if matches!(i?.ty, TypeRef::Func(_) | TypeRef::FuncExact(_)) {
                        imports += 1;
                    }
                }
            }
            Payload::CodeSectionStart { range, .. } => {
                let mut r = wasmparser::BinaryReader::new(&bytes[range.clone()], range.start);
                r.read_var_u32()?;
                end = r.original_position();
            }
            Payload::CodeSectionEntry(body) => {
                sizes.push(u32::try_from(body.range().end - end)?);
                end = body.range().end;
            }
            Payload::CustomSection(reader) => {
                if let KnownCustom::Name(reader) = reader.as_known() {
                    for name in reader {
                        if let Name::Function(map) = name? {
                            for name in map {
                                let name = name?;
                                names.insert(name.index, name.name.to_owned());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let mut result = (0, 0);
    for (i, size) in sizes.into_iter().enumerate() {
        if let Some(name) = names.get(&(imports + i as u32)) {
            let code = Code::new(name);
            if group(code.demangled().unwrap_or(name)) == "formatting" {
                result.0 += 1;
                result.1 += size;
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_callees_do_not_belong_to_either_callers_retained_size() {
        let bytes=wat::parse_str("(module (func $leaf) (func $a (export \"a\") call $leaf) (func $b (export \"b\") call $leaf))").unwrap();
        let report = analyze(&bytes).unwrap();
        assert!(report.path(u32::MAX).is_empty());
        for f in report
            .functions
            .iter()
            .filter(|f| f.name == "a" || f.name == "b")
        {
            assert_eq!(f.retained_bytes, Some(f.shallow_bytes));
        }
        let plain = strip_names(&bytes).unwrap();
        assert!(plain.len() < bytes.len());
        assert_eq!(
            analyze(&plain)
                .unwrap()
                .functions
                .iter()
                .map(|f| f.shallow_bytes)
                .collect::<Vec<_>>(),
            report
                .functions
                .iter()
                .map(|f| f.shallow_bytes)
                .collect::<Vec<_>>()
        );
        assert_eq!(strip_names(&plain).unwrap(), plain);
    }
    #[test]
    fn table_roots_and_gc_types_are_supported() {
        let bytes=wat::parse_str("(module (type (struct (field i32))) (table 1 funcref) (elem (i32.const 0) $f) (func $f))").unwrap();
        assert_eq!(
            analyze(&bytes).unwrap().path(0),
            ["table/global function references", "f"]
        );
    }
    #[test]
    fn noncanonical_function_count_leb_is_section_metadata() {
        let bytes = [
            0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 10, 5, 0x81, 0, 2, 0,
            0x0b,
        ];
        let report = analyze(&bytes).unwrap();
        assert_eq!(report.functions[0].shallow_bytes, 3);
        let named = wat::parse_str("(module (func $core::fmt::write))").unwrap();
        assert_eq!(
            formatting_summary(&named).unwrap(),
            analyze(&named).unwrap().formatting()
        );
    }
}
