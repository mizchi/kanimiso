//! JavaScript Unicode RegExp semantics, not a drop-in replacement for `regex`.
use core::{marker::PhantomData, num::NonZeroU32};

/// The JS engine rejected the pattern. No error strings are copied into Wasm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidPattern;

/// Owns one JS RegExp. `Drop` releases it; `mem::forget` retains it until host GC.
///
/// Uses the `u` flag, without `g`/`y`. `is_match` is stateless. JS backtracking
/// has no linear-time guarantee. Compile once and reuse for repeated matches.
/// This value belongs to one Wasm instance / JS agent (`!Send`, `!Sync`).
pub struct RegExp {
    handle: NonZeroU32,
    local: PhantomData<*mut ()>,
}
impl RegExp {
    #[cfg(feature = "strings")]
    pub fn new_js(pattern: &crate::string::JsString) -> Result<Self, InvalidPattern> {
        let handle = unsafe { ffi::compile_string(pattern.root.raw()) };
        NonZeroU32::new(handle)
            .map(|handle| Self {
                handle,
                local: PhantomData,
            })
            .ok_or(InvalidPattern)
    }
    #[cfg(feature = "strings")]
    pub fn is_match_js(&self, text: &crate::string::JsString) -> bool {
        unsafe { ffi::test_string(self.handle.get(), text.root.raw()) != 0 }
    }
    pub fn new(pattern: &str) -> Result<Self, InvalidPattern> {
        // SAFETY: the synchronous host decodes this live UTF-8 borrow before
        // returning. A nonzero result transfers a unique JS-owned RegExp root.
        let handle = unsafe { ffi::compile(pattern.as_ptr(), pattern.len()) };
        NonZeroU32::new(handle)
            .map(|handle| Self {
                handle,
                local: PhantomData,
            })
            .ok_or(InvalidPattern)
    }
    pub fn is_match(&self, text: &str) -> bool {
        // SAFETY: self owns the live handle; text remains borrowed for the
        // entire synchronous import. Neither pointer nor view may be retained.
        unsafe { ffi::test(self.handle.get(), text.as_ptr(), text.len()) != 0 }
    }
}
impl Drop for RegExp {
    fn drop(&mut self) {
        // SAFETY: the handle has exactly one owner and cannot be constructed
        // through a public raw-handle API or duplicated via Clone.
        unsafe { ffi::release(self.handle.get()) }
    }
}

#[cfg(not(test))]
mod ffi {
    #[link(wasm_import_module = "taraba:helpers/regexp@0.1.0")]
    unsafe extern "C" {
        pub fn compile(ptr: *const u8, len: usize) -> u32;
        pub fn test(handle: u32, ptr: *const u8, len: usize) -> u32;
        #[link_name = "drop"]
        pub fn release(handle: u32);
        #[cfg(feature = "strings")]
        #[link_name = "compile-string"]
        pub fn compile_string(pattern: u32) -> u32;
        #[cfg(feature = "strings")]
        #[link_name = "test-string"]
        pub fn test_string(handle: u32, text: u32) -> u32;
    }
}

#[cfg(test)]
mod ffi {
    use std::{cell::RefCell, collections::BTreeMap, string::String};
    std::thread_local! {
        pub static VALUES: RefCell<BTreeMap<u32, String>> = const { RefCell::new(BTreeMap::new()) };
    }
    // Model ownership and borrowed buffers, not the JS regex algorithm.
    unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
        unsafe { core::str::from_utf8(core::slice::from_raw_parts(ptr, len)).unwrap() }
    }
    pub unsafe fn compile(ptr: *const u8, len: usize) -> u32 {
        let pattern = unsafe { text(ptr, len) };
        if pattern == "[" {
            return 0;
        }
        VALUES.with_borrow_mut(|values| {
            let id = values.keys().next_back().copied().unwrap_or(0) + 1;
            values.insert(id, pattern.into());
            id
        })
    }
    pub unsafe fn test(handle: u32, ptr: *const u8, len: usize) -> u32 {
        let text = unsafe { text(ptr, len) };
        VALUES.with_borrow(|values| u32::from(values[&handle] == text))
    }
    pub unsafe fn release(handle: u32) {
        VALUES.with_borrow_mut(|values| assert!(values.remove(&handle).is_some()));
    }
    #[cfg(feature = "strings")]
    pub unsafe fn compile_string(id: u32) -> u32 {
        let text = crate::text_mock::text(id);
        unsafe { compile(text.as_ptr(), text.len()) }
    }
    #[cfg(feature = "strings")]
    pub unsafe fn test_string(handle: u32, id: u32) -> u32 {
        let text = crate::text_mock::text(id);
        unsafe { test(handle, text.as_ptr(), text.len()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owns_one_handle_and_borrows_input_only_until_return() {
        assert_eq!(core::mem::size_of::<RegExp>(), 4);
        let pattern = std::string::String::from("蟹🦀");
        let a = RegExp::new(&pattern).unwrap();
        drop(pattern);
        let b = RegExp::new("").unwrap();
        assert!(a.is_match("蟹🦀"));
        assert!(!a.is_match("x"));
        assert!(b.is_match(""));
        assert!(RegExp::new("[").is_err());
        ffi::VALUES.with_borrow(|v| assert_eq!(v.len(), 2));
        drop(a);
        ffi::VALUES.with_borrow(|v| assert_eq!(v.len(), 1));
        drop(b);
        ffi::VALUES.with_borrow(|v| assert!(v.is_empty()));
    }
    #[test]
    fn handles_are_neither_send_nor_sync() {
        trait AmbiguousSend<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousSend<()> for T {}
        impl<T: ?Sized + Send> AmbiguousSend<u8> for T {}
        let _ = <RegExp as AmbiguousSend<_>>::check;
        trait AmbiguousSync<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousSync<()> for T {}
        impl<T: ?Sized + Sync> AmbiguousSync<u8> for T {}
        let _ = <RegExp as AmbiguousSync<_>>::check;
    }
}
