//! Build WIT-based Rust libraries as Components or typed npm packages.
//!
//! [`build_component`] preserves the standard Canonical ABI. [`build`] uses the
//! selected lightweight Core execution contract. [`package_component`] and
//! [`package_core`] add distribution files; neither publishes a package.
mod abi;
mod bindings;
mod build;
mod component;
mod core_async;
mod core_resources;
mod core_types;
mod detect;
mod helpers;
mod imports;
pub mod insight;
mod interfaces;
mod package;
mod profile;
mod project;
mod runtime_abi;
mod wit;
pub use build::{BuildOptions, build};
pub use component::{ComponentOptions, build_component};
pub use core_async::generate_core_bindings;
pub use detect::detect_core_profile;
pub use package::{NpmOptions, package_component, package_core};
pub use profile::ExecutionProfile;
pub use project::{new_component_project, new_future_project, new_jspi_project, new_project};
