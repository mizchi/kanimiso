//! Owned JS strings. Copy UTF-8 into Rust only when explicitly requested.
use crate::{handle::Root, text_ffi::strings};

#[derive(Clone, Copy)]
#[repr(u32)]
pub enum Normalization {
    Nfc,
    Nfd,
    Nfkc,
    Nfkd,
}

/// An immutable JS string root. Clone shares its JS value, not its root ID.
/// No Rust allocation is needed unless `to_rust_string` (`alloc`) is used.
#[derive(Clone)]
pub struct JsString {
    pub(crate) root: Root,
}
impl From<&str> for JsString {
    fn from(text: &str) -> Self {
        // SAFETY: host synchronously decodes valid borrowed UTF-8, retaining no
        // pointer/view. A successful import always returns a nonzero owned root.
        unsafe {
            Self::from_root(Root::from_raw(strings::from_utf8(
                text.as_ptr(),
                text.len(),
            )))
        }
    }
}
impl JsString {
    pub(crate) fn from_root(root: Root) -> Self {
        Self { root }
    }
    pub fn utf8_len(&self) -> usize {
        unsafe { strings::utf8_len(self.root.raw()) }
    }
    /// JS string length in UTF-16 code units, not Rust bytes or graphemes.
    pub fn utf16_len(&self) -> u32 {
        unsafe { strings::utf16_len(self.root.raw()) }
    }
    pub fn is_empty(&self) -> bool {
        self.utf16_len() == 0
    }
    /// Write the largest complete UTF-8 prefix that fits. Never split a scalar.
    /// Returns bytes written; the rest of the buffer remains unchanged.
    pub fn write_utf8(&self, output: &mut [u8]) -> usize {
        // SAFETY: the host writes only within this live mutable borrow and
        // returns synchronously. TextEncoder.encodeInto emits valid UTF-8.
        unsafe { strings::copy_utf8(self.root.raw(), output.as_mut_ptr(), output.len()) }
    }
    #[cfg(feature = "alloc")]
    pub fn to_rust_string(&self) -> alloc::string::String {
        let mut bytes = alloc::vec![0; self.utf8_len()];
        let written = self.write_utf8(&mut bytes);
        bytes.truncate(written);
        // SAFETY: copy_utf8 only writes complete UTF-8 sequences. Rust does not
        // expose borrowed JS UTF-16 storage as &str or a Wasm memory slice.
        unsafe { alloc::string::String::from_utf8_unchecked(bytes) }
    }
    pub fn normalize(&self, form: Normalization) -> Self {
        unsafe {
            Self::from_root(Root::from_raw(strings::normalize(
                self.root.raw(),
                form as u32,
            )))
        }
    }
    /// ECMAScript default Unicode uppercase conversion, not locale-specific.
    pub fn to_uppercase(&self) -> Self {
        unsafe { Self::from_root(Root::from_raw(strings::to_uppercase(self.root.raw()))) }
    }
    pub fn to_lowercase(&self) -> Self {
        unsafe { Self::from_root(Root::from_raw(strings::to_lowercase(self.root.raw()))) }
    }
    /// ECMAScript whitespace trimming semantics.
    pub fn trim(&self) -> Self {
        unsafe { Self::from_root(Root::from_raw(strings::trim(self.root.raw()))) }
    }
    /// Lazily yield owned JS strings, one JS Unicode code point per item.
    #[cfg(feature = "iterator")]
    pub fn code_points(&self) -> crate::iter::JsIterator<JsString> {
        unsafe {
            crate::iter::JsIterator::from_root(Root::from_raw(strings::code_points(
                self.root.raw(),
            )))
        }
    }
}
impl PartialEq for JsString {
    fn eq(&self, other: &Self) -> bool {
        unsafe { strings::equals(self.root.raw(), other.root.raw()) != 0 }
    }
}
impl Eq for JsString {}
#[cfg(feature = "iterator")]
impl crate::iter::FromRoot for JsString {
    fn from_root(root: Root) -> Self {
        Self::from_root(root)
    }
}
