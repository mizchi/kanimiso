// Exclusive<T> derived from wee_alloc_bw @ 9a9adc2106df80abd25501194275d7d51a1ba4c4.
// MPL-2.0: see ../LICENSE. Arena backend is specific to this experiment.
// Test-only bounded arena; no mmap/system allocator, so Miri can inspect every access.
use crate::{const_init::ConstInit, AllocErr};
#[cfg(feature = "extra_assertions")]
use core::cell::Cell;
use core::{
    cell::UnsafeCell,
    ptr::NonNull,
    sync::atomic::{AtomicUsize, Ordering},
};
use memory_units::Pages;
const BYTES: usize = 16 * 1024 * 1024;
#[repr(align(16))]
struct Arena(UnsafeCell<[u8; BYTES]>);
unsafe impl Sync for Arena {}
static ARENA: Arena = Arena(UnsafeCell::new([0; BYTES]));
static OFFSET: AtomicUsize = AtomicUsize::new(0);
pub(crate) unsafe fn alloc_pages(n: Pages) -> Result<NonNull<u8>, AllocErr> {
    let bytes = n.0.checked_mul(65536).ok_or(AllocErr)?;
    let start = OFFSET
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
            v.checked_add(bytes).filter(|end| *end <= BYTES)
        })
        .map_err(|_| AllocErr)?;
    NonNull::new(ARENA.0.get().cast::<u8>().add(start)).ok_or(AllocErr)
}
pub(crate) struct Exclusive<T> {
    inner: UnsafeCell<T>,

    #[cfg(feature = "extra_assertions")]
    in_use: Cell<bool>,
}

impl<T: ConstInit> ConstInit for Exclusive<T> {
    const INIT: Self = Exclusive {
        inner: UnsafeCell::new(T::INIT),

        #[cfg(feature = "extra_assertions")]
        in_use: Cell::new(false),
    };
}

extra_only! {
    fn assert_not_in_use<T>(excl: &Exclusive<T>) {
        assert!(!excl.in_use.get(), "`Exclusive<T>` is not re-entrant");
    }
}

extra_only! {
    fn set_in_use<T>(excl: &Exclusive<T>) {
        excl.in_use.set(true);
    }
}

extra_only! {
    fn set_not_in_use<T>(excl: &Exclusive<T>) {
        excl.in_use.set(false);
    }
}

impl<T> Exclusive<T> {
    /// Get exclusive, mutable access to the inner value.
    ///
    /// # Safety
    ///
    /// It is the callers' responsibility to ensure that `f` does not re-enter
    /// this method for this `Exclusive` instance.
    //
    // XXX: If we don't mark this function inline, then it won't be, and the
    // code size also blows up by about 200 bytes.
    #[inline]
    pub(crate) unsafe fn with_exclusive_access<'a, F, U>(&'a self, f: F) -> U
    where
        for<'x> F: FnOnce(&'x mut T) -> U,
    {
        assert_not_in_use(self);
        set_in_use(self);
        let result = f(&mut *self.inner.get());
        set_not_in_use(self);
        result
    }
}

// Scope owns the test arena until every allocator using it has left the test.
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub(crate) struct Scope {
    _guard: std::sync::MutexGuard<'static, ()>,
}
pub(crate) fn scope() -> Scope {
    let guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    OFFSET.store(0, Ordering::Relaxed);
    Scope { _guard: guard }
}
