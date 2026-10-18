//! Fixed, pinned backing bytes; allocation metadata is owned by the linked intrusive free-list module.
use core::{cell::UnsafeCell, mem::MaybeUninit};
#[repr(align(64))]
struct Bytes(UnsafeCell<[MaybeUninit<u8>; 131072]>);
// Single-agent, non-shared Wasm only (enforced by build.rs). The host assigns
// disjoint live slots. No Rust reference to the backing bytes escapes this module.
unsafe impl Sync for Bytes {}
static STORAGE: Bytes = Bytes(UnsafeCell::new([MaybeUninit::uninit(); 131072]));
/// Exposes the address, without creating a reference to any live Future.
pub fn base() -> *mut u8 {
    STORAGE.0.get().cast::<u8>()
}
#[cfg(test)]
mod tests {
    #[test]
    fn backing_bytes_have_the_required_layout() {
        assert_eq!(super::base().addr() % 64, 0);
        assert_eq!(core::mem::size_of::<super::Bytes>(), 131072);
    }
}

/// # Safety
/// Private raw fixture ABI: release each returned live pointer once only.
pub unsafe fn reserve(bytes: u32, align: u32) -> u32 {
    unsafe { crate::ffi::allocate(base() as u32, bytes, align) }
}
/// # Safety
/// Pointer must be an unreleased slot belonging to this instance.
pub unsafe fn release(pointer: u32) {
    unsafe { crate::ffi::free(pointer) }
}
/// Private fixture diagnostics, eliminated from shipping modules.
pub fn used() -> u32 {
    unsafe { crate::ffi::used() }
}
