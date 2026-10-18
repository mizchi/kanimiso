// Derived from wee_alloc_bw @ 9a9adc2106df80abd25501194275d7d51a1ba4c4.
// MPL-2.0: see ../LICENSE. Modified for this wasm32-only experiment.
//! An intrusive, doubly-linked list of adjacent cells.

use core::cell::Cell;
use core::marker::PhantomData;
use core::ptr;

/// TODO FITZGEN
///
/// ### Safety
///
/// TODO FITZGEN
pub unsafe trait HasNeighbors<'a, T>: AsRef<Neighbors<'a, T>>
where
    T: 'a + HasNeighbors<'a, T>,
{
    unsafe fn next_checked(neighbors: &Neighbors<'a, T>, next: *const T) -> Option<&'a T>;
    unsafe fn prev_checked(neighbors: &Neighbors<'a, T>, prev: *const T) -> Option<&'a T>;
}

#[derive(Debug)]
pub struct Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    next_raw: Cell<*const T>,
    prev_raw: Cell<*const T>,
    _phantom: PhantomData<&'a T>,
}

impl<'a, T> Default for Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    fn default() -> Self {
        Neighbors {
            next_raw: Cell::new(ptr::null_mut()),
            prev_raw: Cell::new(ptr::null_mut()),
            _phantom: PhantomData,
        }
    }
}

// Add this `cfg` so that the build will break on platforms with bizarre word
// sizes, where we might not have acceess to these low bits.
#[cfg(any(target_pointer_width = "32", target_pointer_width = "64"))]
impl<'a, T> Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    // We use two low bits from each of our pointers.
    pub const BIT_1: usize = 0b01;
    pub const BIT_2: usize = 0b10;

    // Mask to get just the low bits.
    const BITS_MASK: usize = 0b11;

    // Mask to get the aligned pointer.
    const PTR_MASK: usize = !0b11;
}

#[test]
fn can_use_low_bits() {
    #[cfg(not(target_arch = "wasm32"))]
    let _arena = crate::imp::scope();
    use core::mem;
    assert!(
        mem::align_of::<*const u8>() >= 0b100,
        "we rely on being able to stick tags into the lowest two bits"
    );
}

/// Get bits.
#[allow(dead_code)]
impl<'a, T> Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    #[inline]
    fn bits(raw: *const T) -> usize {
        raw.addr() & Self::BITS_MASK
    }

    #[inline]
    fn untagged(raw: *const T) -> *const T {
        raw.map_addr(|addr| addr & Self::PTR_MASK)
    }

    #[inline]
    fn with_bits(raw: *const T, bits: usize) -> *const T {
        extra_assert_eq!(bits & Self::PTR_MASK, 0);
        raw.map_addr(|addr| (addr & Self::PTR_MASK) | bits)
    }

    #[inline]
    pub fn get_next_bit_1(&self) -> bool {
        Self::bits(self.next_raw.get()) & Self::BIT_1 != 0
    }

    #[inline]
    pub fn get_next_bit_2(&self) -> bool {
        Self::bits(self.next_raw.get()) & Self::BIT_2 != 0
    }

    #[inline]
    pub fn get_prev_bit_1(&self) -> bool {
        Self::bits(self.prev_raw.get()) & Self::BIT_1 != 0
    }

    #[inline]
    pub fn get_prev_bit_2(&self) -> bool {
        Self::bits(self.prev_raw.get()) & Self::BIT_2 != 0
    }
}

/// Set bits.
#[allow(dead_code)]
impl<'a, T> Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    #[inline]
    pub fn set_next_bit_1(&self) {
        self.next_raw.set(Self::with_bits(
            self.next_raw.get(),
            Self::bits(self.next_raw.get()) | Self::BIT_1,
        ));
    }

    #[inline]
    pub fn set_next_bit_2(&self) {
        self.next_raw.set(Self::with_bits(
            self.next_raw.get(),
            Self::bits(self.next_raw.get()) | Self::BIT_2,
        ));
    }

    #[inline]
    pub fn set_prev_bit_1(&self) {
        self.prev_raw.set(Self::with_bits(
            self.prev_raw.get(),
            Self::bits(self.prev_raw.get()) | Self::BIT_1,
        ));
    }

    #[inline]
    pub fn set_prev_bit_2(&self) {
        self.prev_raw.set(Self::with_bits(
            self.prev_raw.get(),
            Self::bits(self.prev_raw.get()) | Self::BIT_2,
        ));
    }
}

/// Clear bits.
#[allow(dead_code)]
impl<'a, T> Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    #[inline]
    pub fn clear_next_bit_1(&self) {
        self.next_raw.set(Self::with_bits(
            self.next_raw.get(),
            Self::bits(self.next_raw.get()) & !Self::BIT_1,
        ));
    }

    #[inline]
    pub fn clear_next_bit_2(&self) {
        self.next_raw.set(Self::with_bits(
            self.next_raw.get(),
            Self::bits(self.next_raw.get()) & !Self::BIT_2,
        ));
    }

    #[inline]
    pub fn clear_prev_bit_1(&self) {
        self.prev_raw.set(Self::with_bits(
            self.prev_raw.get(),
            Self::bits(self.prev_raw.get()) & !Self::BIT_1,
        ));
    }

    #[inline]
    pub fn clear_prev_bit_2(&self) {
        self.prev_raw.set(Self::with_bits(
            self.prev_raw.get(),
            Self::bits(self.prev_raw.get()) & !Self::BIT_2,
        ));
    }
}

/// Get pointers.
impl<'a, T> Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    #[inline]
    pub fn next_unchecked(&self) -> *const T {
        Self::untagged(self.next_raw.get())
    }

    #[inline]
    pub fn prev_unchecked(&self) -> *const T {
        Self::untagged(self.prev_raw.get())
    }

    #[inline]
    pub fn next(&self) -> Option<&'a T> {
        unsafe { T::next_checked(self, self.next_unchecked()) }
    }

    #[inline]
    pub fn prev(&self) -> Option<&'a T> {
        unsafe { T::prev_checked(self, self.prev_unchecked()) }
    }
}

/// Sibling pointer setters that don't attempt to make sure the doubly-linked
/// list is well-formed. The pointers are required to be aligned, however, and
/// the low bits are not clobbered.
impl<'a, T> Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    #[inline]
    pub unsafe fn set_next(&self, next: *const T) {
        extra_assert_eq!(next.addr() & Self::BITS_MASK, 0);
        let old_bits = Self::bits(self.next_raw.get());
        self.next_raw.set(Self::with_bits(next, old_bits));
    }

    #[inline]
    pub unsafe fn set_prev(&self, prev: *const T) {
        extra_assert_eq!(prev.addr() & Self::BITS_MASK, 0);
        let old_bits = Self::bits(self.prev_raw.get());
        self.prev_raw.set(Self::with_bits(prev, old_bits));
    }
}

/// Raw sibling pointer getters that include the lower bits too, if any are set.
#[allow(dead_code)]
impl<'a, T> Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    #[inline]
    pub unsafe fn next_and_bits(&self) -> *const T {
        self.next_raw.get()
    }

    #[inline]
    pub unsafe fn prev_and_bits(&self) -> *const T {
        self.prev_raw.get()
    }
}

/// Raw sibling pointer setters that clobber the lower bits too.
#[allow(dead_code)]
impl<'a, T> Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    #[inline]
    pub unsafe fn set_next_and_bits(&self, next_and_bits: *const T) {
        self.next_raw.set(next_and_bits);
    }

    #[inline]
    pub unsafe fn set_prev_and_bits(&self, prev_and_bits: *const T) {
        self.prev_raw.set(prev_and_bits);
    }
}

/// Higher level list manipulations.
///
/// These do not modify or propagate any bits; that is the caller's
/// responsibility.
impl<'a, T> Neighbors<'a, T>
where
    T: 'a + HasNeighbors<'a, T>,
{
    #[inline]
    pub fn remove(&self) {
        unsafe {
            if let Some(next) = self.next() {
                next.as_ref().set_prev(self.prev_unchecked());
            }

            if let Some(prev) = self.prev() {
                prev.as_ref().set_next(self.next_unchecked());
            }

            self.set_next(ptr::null_mut());
            self.set_prev(ptr::null_mut());
        }
    }

    #[inline]
    pub unsafe fn append_raw(me: *const T, neighbor: *const T) {
        extra_assert!((*neighbor).as_ref().next_unchecked().is_null());
        extra_assert!((*neighbor).as_ref().prev_unchecked().is_null());

        (*neighbor)
            .as_ref()
            .set_next((*me).as_ref().next_unchecked());
        if let Some(next) = (*me).as_ref().next() {
            next.as_ref().set_prev(neighbor);
        }

        (*neighbor).as_ref().set_prev(me);
        (*me).as_ref().set_next(neighbor);
    }
}
