//! Opt-in JS builtins. No allocator, `std`, or Rust async executor required.
#![no_std]

#[cfg(all(not(target_arch = "wasm32"), not(test)))]
compile_error!("taraba-helpers requires a JavaScript-hosted wasm32 target");

#[cfg(feature = "alloc")]
extern crate alloc;
#[cfg(test)]
extern crate std;

#[cfg(feature = "values")]
mod handle;
#[cfg(all(feature = "values", not(test)))]
mod text_ffi;
#[cfg(all(feature = "values", test))]
mod text_mock;
#[cfg(all(feature = "values", test))]
use text_mock as text_ffi;
#[cfg(feature = "encoding")]
pub mod encoding;
#[cfg(feature = "iterator")]
pub mod iter;
#[cfg(feature = "segmenter")]
pub mod segmenter;
#[cfg(feature = "strings")]
pub mod string;

#[cfg(feature = "regexp")]
pub mod regexp;

#[cfg(all(test, feature = "segmenter", feature = "encoding", feature = "alloc"))]
mod text_tests;
