//! The CLI and its private Rust/JS ABI follow the same compatibility line.
use semver::Version;
use serde_json::Value;
use std::{collections::BTreeSet, error::Error};
type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub fn same_line(previous: &str, current: &str) -> Result<bool> {
    let a = Version::parse(previous)?;
    let b = Version::parse(current)?;
    Ok(if !a.pre.is_empty() || !b.pre.is_empty() {
        a == b
    } else {
        a.major == b.major
            && (a.major != 0 || (a.minor == b.minor && (a.minor != 0 || a.patch == b.patch)))
    })
}

pub fn normal_packages<'a>(data: &'a Value, selected: &str) -> Vec<&'a Value> {
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
                    .is_some_and(|ks| ks.iter().any(|k| k["kind"].is_null()))
                {
                    if let Some(id) = dep["pkg"].as_str() {
                        pending.push(id.to_owned());
                    }
                }
            }
        }
    }
    data["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            p["id"]
                .as_str()
                .is_some_and(|id| id != selected && reachable.contains(id))
        })
        .collect()
}

pub fn validate(data: &Value, selected: &str) -> Result<()> {
    for package in normal_packages(data, selected) {
        if matches!(package["name"].as_str(), Some("taraba" | "taraba-helpers")) {
            let version = package["version"]
                .as_str()
                .ok_or("invalid runtime crate version")?;
            if !same_line(version, env!("CARGO_PKG_VERSION"))? {
                return Err(format!("{} {version} is incompatible with CLI {}; update the Rust dependency requirement/lockfile or use a matching CLI before rebuilding", package["name"].as_str().unwrap(), env!("CARGO_PKG_VERSION")).into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_lines_keep_zero_major_and_prerelease_boundaries() {
        for (a, b, compatible) in [
            ("0.1.0", "0.1.2", true),
            ("0.1.2", "0.2.0", false),
            ("0.0.1", "0.0.2", false),
            ("1.0.0", "1.3.0", true),
            ("1.9.0", "2.0.0", false),
            ("0.1.0-beta.1", "0.1.0", false),
            ("0.1.0-beta.1", "0.1.0-beta.1", true),
        ] {
            assert_eq!(same_line(a, b).unwrap(), compatible);
        }
    }
    #[test]
    fn unrelated_workspace_dev_and_build_dependencies_do_not_restrict_the_cli() {
        let data = serde_json::json!({"packages":[
            {"id":"app","name":"app"},
            {"id":"runtime","name":"taraba","version":"9.0.0"}
        ], "resolve":{"nodes":[{"id":"app","deps":[{"pkg":"runtime","dep_kinds":[{"kind":"dev"},{"kind":"build"}]}]}]}});
        assert!(validate(&data, "app").is_ok());
        let mut normal = data.clone();
        normal["resolve"]["nodes"][0]["deps"][0]["dep_kinds"] = serde_json::json!([{"kind":null}]);
        assert!(validate(&normal, "app").is_err());
    }
}
