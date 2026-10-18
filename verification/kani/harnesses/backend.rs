// Verification-only single-agent backend: all page refill attempts return OOM.
// Harnesses seed one real bounded free cell; the allocator logic is unchanged.
use crate::{const_init::ConstInit, AllocErr};
use core::{cell::UnsafeCell, ptr::NonNull};
use memory_units::Pages;
static mut REFILLS: usize = 0;
pub(crate) fn used() -> usize {
    unsafe { REFILLS }
}
pub(crate) unsafe fn alloc_pages(_: Pages) -> Result<NonNull<u8>, AllocErr> {
    REFILLS += 1;
    Err(AllocErr)
}
pub(crate) struct Exclusive<T> {
    inner: UnsafeCell<T>,
}
impl<T: ConstInit> ConstInit for Exclusive<T> {
    const INIT: Self = Self {
        inner: UnsafeCell::new(T::INIT),
    };
}
impl<T> Exclusive<T> {
    pub(crate) unsafe fn with_exclusive_access<'a, F, U>(&'a self, f: F) -> U
    where
        for<'x> F: FnOnce(&'x mut T) -> U,
    {
        f(&mut *self.inner.get())
    }
}
pub(crate) fn scope() {}
