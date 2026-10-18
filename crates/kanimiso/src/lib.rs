//! Experimental Promise-first, single-thread Rust/JS runtime.
//! Requires `alloc`; the embedding application chooses its allocator/panic handler.
#![cfg_attr(not(feature = "std"), no_std)]
#[cfg(all(target_family = "wasm", target_feature = "atomics"))]
compile_error!("jsrt externref supports non-shared, single-thread wasm only");
extern crate alloc;
#[cfg(all(not(target_arch = "wasm32"), not(test)))]
compile_error!("js-local runtime requires a wasm32 single-agent JS host");
#[cfg(test)]
extern crate std;

mod ffi;
mod promise;
pub mod storage;
mod task;
mod value;
mod waker;
pub use promise::{JsFuture, JsPromise};
pub use task::{JoinHandle, future_to_promise, spawn_local};
pub use value::{HostError, JsValue};

/// Internal ABI: pointers come only from this instance's host registry, and calls
/// are serialized. The host never polls/drops an active task or settles a freed wait.
pub mod abi {
    /// # Safety
    /// `pointer` is a live task allocated by this runtime; no reentrant poll/drop.
    pub unsafe fn poll(pointer: u32) -> i32 {
        unsafe { crate::task::poll(pointer) }
    }
    /// # Safety
    /// The task has returned from poll and will never be polled/dropped again.
    pub unsafe fn drop_task(pointer: u32) {
        unsafe { crate::task::drop_task(pointer) }
    }
    /// # Safety
    /// `pointer` is a live pinned subscription state. `value` transfers one root.
    pub unsafe fn settle(pointer: u32, value: u32, rejected: i32) {
        unsafe { crate::promise::settle(pointer, value, rejected) }
    }
}
