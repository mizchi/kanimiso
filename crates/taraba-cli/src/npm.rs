//! npm identity overrides. Cargo metadata supplies defaults for project builds.
use std::{error::Error, path::Path};
use taraba_cli::NpmOptions;

type Result<T> = std::result::Result<T, Box<dyn Error>>;
#[derive(Default)]
pub struct Overrides {
    pub name: Option<String>,
    pub version: Option<String>,
    pub license: Option<String>,
}
impl Overrides {
    pub fn resolve(&self, defaults: NpmOptions) -> Result<NpmOptions> {
        let options = NpmOptions {
            name: self.name.clone().unwrap_or(defaults.name),
            version: self.version.clone().unwrap_or(defaults.version),
            license: self.license.clone().unwrap_or(defaults.license),
        };
        options.validate()?;
        Ok(options)
    }
    pub fn validate(&self) -> Result<()> {
        self.resolve(wasm_defaults(Path::new("taraba-package.wasm")))?;
        Ok(())
    }
}
pub fn wasm_defaults(path: &Path) -> NpmOptions {
    NpmOptions {
        name: path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("taraba-package")
            .to_ascii_lowercase(),
        version: "0.1.0".into(),
        license: "UNLICENSED".into(),
    }
}
pub fn cargo_defaults(package: &serde_json::Value) -> Result<NpmOptions> {
    Ok(NpmOptions {
        name: package["name"]
            .as_str()
            .ok_or("invalid Cargo package name")?
            .to_ascii_lowercase(),
        version: package["version"]
            .as_str()
            .ok_or("invalid Cargo package version")?
            .into(),
        license: package["license"].as_str().unwrap_or("UNLICENSED").into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cargo_identity_is_inherited_and_each_flag_can_override_it() {
        let defaults = || {
            cargo_defaults(&serde_json::json!({"name":"My-Library", "version":"2.3.4", "license":"MIT OR Apache-2.0"})).unwrap()
        };
        let inherited = Overrides::default().resolve(defaults()).unwrap();
        assert_eq!(inherited.name, "my-library");
        assert_eq!(inherited.version, "2.3.4");
        assert_eq!(inherited.license, "MIT OR Apache-2.0");
        let changed = Overrides {
            name: Some("@scope/library".into()),
            version: Some("3.0.0-beta.1".into()),
            license: Some("Apache-2.0".into()),
        }
        .resolve(defaults())
        .unwrap();
        assert_eq!(changed.name, "@scope/library");
        assert_eq!(changed.version, "3.0.0-beta.1");
        assert_eq!(changed.license, "Apache-2.0");
        assert!(
            Overrides {
                version: Some("v1.0".into()),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
    #[test]
    fn raw_wasm_uses_its_stem_with_an_explicit_license_fallback() {
        let identity = wasm_defaults(Path::new("target/Hello.wasm"));
        assert_eq!(identity.name, "hello");
        assert_eq!(identity.version, "0.1.0");
        assert_eq!(identity.license, "UNLICENSED");
    }
}
