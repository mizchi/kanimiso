use crate::ffi;
use core::{marker::PhantomData, mem::ManuallyDrop};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostError(pub i32);
/// An owned slot in a native externref table, with no object data in linear memory.
/// Slots are private to Rust ownership; the public ABI accepts JS references, not raw slots.
/// Clone retains the same root; Drop releases it, never deep-copies the JS value.
/// This handle is local to one JS agent and Wasm instance (`!Send`, `!Sync`).
/// ```compile_fail
/// use jsrt::JsValue;
/// fn invalid(value: JsValue) { std::thread::spawn(move || drop(value)); }
/// ```
#[repr(transparent)]
pub struct JsValue {
    raw: u32,
    local: PhantomData<*mut ()>,
}
impl JsValue {
    pub const fn undefined() -> Self {
        Self {
            raw: 0,
            local: PhantomData,
        }
    }
    pub fn from_i32(value: i32) -> Self {
        unsafe { Self::from_abi(ffi::number(value)) }
    }
    pub fn as_i32(&self) -> Result<i32, HostError> {
        let number = unsafe { ffi::as_i32(self.raw) };
        if number.is_nan() {
            Err(HostError(-2))
        } else {
            Ok(number as i32)
        }
    }
    /// # Safety
    /// `raw` transfers one live value root belonging to this host/instance.
    pub unsafe fn from_abi(raw: u32) -> Self {
        Self {
            raw,
            local: PhantomData,
        }
    }
    pub fn into_abi(self) -> u32 {
        ManuallyDrop::new(self).raw
    }
    pub(crate) fn raw(&self) -> u32 {
        self.raw
    }
}
impl Clone for JsValue {
    fn clone(&self) -> Self {
        unsafe {
            ffi::retain(self.raw);
            Self::from_abi(self.raw)
        }
    }
}
impl Drop for JsValue {
    fn drop(&mut self) {
        unsafe {
            ffi::release(self.raw);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::JsValue;
    #[test]
    fn values_are_neither_send_nor_sync() {
        // Type inference is ambiguous if JsValue implements the forbidden trait.
        trait AmbiguousSend<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousSend<()> for T {}
        impl<T: ?Sized + Send> AmbiguousSend<u8> for T {}
        let _ = <JsValue as AmbiguousSend<_>>::check;
        trait AmbiguousSync<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousSync<()> for T {}
        impl<T: ?Sized + Sync> AmbiguousSync<u8> for T {}
        let _ = <JsValue as AmbiguousSync<_>>::check;
    }
}
