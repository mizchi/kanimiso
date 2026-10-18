// Derived from wee_alloc_bw @ 9a9adc2106df80abd25501194275d7d51a1ba4c4.
// MPL-2.0: see ../LICENSE. Modified for this wasm32-only experiment.
//! Wasm32-only experimental port of wee_alloc_bw; see ../LICENSE and ../../UPSTREAM.json.
//! Stable GlobalAlloc, single JS agent, no shared memory; not a production certification.
#![no_std]
#[cfg(test)]
extern crate std;
#[cfg(all(not(target_arch = "wasm32"), not(test)))]
compile_error!("kanimiso-allocator supports wasm32 only; native backend is test-only");
#[cfg(target_feature = "atomics")]
compile_error!("kanimiso-allocator supports non-shared single-thread Wasm only");
#[macro_use]
mod extra_assert;
mod const_init;
#[cfg(target_arch = "wasm32")]
#[path = "imp_wasm32.rs"]
mod imp;
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "imp_test.rs"]
mod imp;
mod neighbors;
#[cfg(feature = "size_classes")]
mod size_classes;
use core::alloc::{GlobalAlloc, Layout};
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(crate) struct AllocErr;
impl AllocErr {
    fn new() -> Self {
        Self
    }
}
use crate::const_init::ConstInit;
use crate::neighbors::Neighbors;
use core::cell::Cell;
use core::cmp;
use core::marker::Sync;
#[cfg(test)]
use core::mem;
use core::ptr::{self, NonNull};
use memory_units::{size_of, ByteSize, Bytes, Pages, RoundUpTo, Words};

/// The WebAssembly page size, in bytes.
pub const PAGE_SIZE: Bytes = Bytes(65536);

extra_only! {
    fn assert_is_word_aligned<T>(ptr: *const T) {
        assert_aligned_to(ptr, size_of::<usize>());
    }
}

extra_only! {
    fn assert_aligned_to<T>(ptr: *const T, align: Bytes) {
        extra_assert_eq!(
            ptr as usize % align.0,
            0,
            "{:p} is not aligned to {}",
            ptr,
            align.0
        );
    }
}

#[inline]
fn checked_round_up_to<T>(b: Bytes) -> Option<T>
where
    T: ByteSize,
    Bytes: RoundUpTo<T>,
{
    if b.0.checked_add(T::BYTE_SIZE.0).is_none() {
        None
    } else {
        Some(b.round_up_to())
    }
}

#[repr(C)]
#[derive(Default, Debug)]
struct CellHeader<'a> {
    neighbors: Neighbors<'a, CellHeader<'a>>,
}

impl<'a> AsRef<Neighbors<'a, CellHeader<'a>>> for CellHeader<'a> {
    fn as_ref(&self) -> &Neighbors<'a, CellHeader<'a>> {
        &self.neighbors
    }
}

unsafe impl<'a> neighbors::HasNeighbors<'a, CellHeader<'a>> for CellHeader<'a> {
    #[inline]
    unsafe fn next_checked(
        neighbors: &Neighbors<'a, CellHeader<'a>>,
        next: *const CellHeader<'a>,
    ) -> Option<&'a CellHeader<'a>> {
        if next.is_null() || CellHeader::next_cell_is_invalid(neighbors) {
            None
        } else {
            Some(&*next)
        }
    }

    #[inline]
    unsafe fn prev_checked(
        _neighbors: &Neighbors<'a, CellHeader<'a>>,
        prev: *const CellHeader<'a>,
    ) -> Option<&'a CellHeader<'a>> {
        if prev.is_null() {
            None
        } else {
            Some(&*prev)
        }
    }
}

#[repr(C)]
#[derive(Debug)]
struct AllocatedCell<'a> {
    header: CellHeader<'a>,
}

#[test]
fn allocated_cell_layout() {
    #[cfg(not(target_arch = "wasm32"))]
    let _arena = crate::imp::scope();
    assert_eq!(
        size_of::<CellHeader>(),
        size_of::<AllocatedCell>(),
        "Safety and correctness depends on AllocatedCell being the same as CellHeader"
    );

    assert_eq!(
        mem::align_of::<CellHeader>(),
        mem::align_of::<AllocatedCell>()
    );
}

#[repr(C)]
#[derive(Debug)]
struct FreeCell<'a> {
    header: CellHeader<'a>,
    next_free_raw: Cell<*const FreeCell<'a>>,
}

#[test]
fn free_cell_layout() {
    #[cfg(not(target_arch = "wasm32"))]
    let _arena = crate::imp::scope();
    assert_eq!(
        size_of::<CellHeader>() + Words(1),
        size_of::<FreeCell>(),
        "Safety and correctness depends on FreeCell being only one word larger than CellHeader"
    );

    assert_eq!(
        mem::align_of::<CellHeader>(),
        mem::align_of::<AllocatedCell>()
    );
}

#[cfg(feature = "extra_assertions")]
impl<'a> CellHeader<'a> {
    // Whenever a `Cell` is inserted into a size class's free list (either
    // because it was just freed or because it was freshly allocated from some
    // upstream source), we write this pattern over the `Cell`'s data.
    //
    // If you see unexpected `0x35353535` values, then either (a) you have a
    // use-after-free, or (b) there is a bug in `wee_alloc` and its size classes
    // implementation.
    #[cfg(feature = "size_classes")]
    const SIZE_CLASS_FREE_PATTERN: u8 = 0x35;

    // Same thing as above, but for data inside the no-size-class/large
    // allocations free list.
    //
    // If you see unexpected `0x57575757` values, then either (a) you have a
    // use-after-free, or (b) there is a bug in `wee_alloc` and its main free
    // list implementation.
    const LARGE_FREE_PATTERN: u8 = 0x57;
}

impl<'a> CellHeader<'a> {
    // ### Semantics of Low Bits in Neighbors Pointers
    //
    // If `self.neighbors.next_bit_1` is set, then the cell is allocated, and
    // should never be in the free list. If the bit is not set, then this cell
    // is free, and must be in the free list (or is in the process of being
    // added to the free list).
    //
    // The `self.neighbors.next` pointer always points to the byte just *after*
    // this cell. If the `self.neighbors.next_bit_2` bit is not set, then it
    // points to the next cell. If that bit is set, then it points to the
    // invalid memory that follows this cell.

    fn is_allocated(&self) -> bool {
        self.neighbors.get_next_bit_1()
    }

    fn is_free(&self) -> bool {
        !self.is_allocated()
    }

    fn set_allocated(neighbors: &Neighbors<'a, Self>) {
        neighbors.set_next_bit_1();
    }

    fn set_free(neighbors: &Neighbors<'a, Self>) {
        neighbors.clear_next_bit_1();
    }

    fn next_cell_is_invalid(neighbors: &Neighbors<'a, Self>) -> bool {
        neighbors.get_next_bit_2()
    }

    fn set_next_cell_is_invalid(neighbors: &Neighbors<'a, Self>) {
        neighbors.set_next_bit_2();
    }

    fn clear_next_cell_is_invalid(neighbors: &Neighbors<'a, Self>) {
        neighbors.clear_next_bit_2();
    }

    fn size(&self) -> Bytes {
        let data = unsafe { (self as *const CellHeader<'a>).offset(1) };
        assert_is_word_aligned(data);
        let data = data as usize;

        let next = self.neighbors.next_unchecked();
        assert_is_word_aligned(next);
        let next = next as usize;

        extra_assert!(
            next > data,
            "the next cell ({:p}) should always be after the data ({:p})",
            next as *const (),
            data as *const ()
        );
        Bytes(next - data)
    }

    // Get a pointer to this cell's data without regard to whether this cell is
    // allocated or free.
    unsafe fn unchecked_data(&self) -> *const u8 {
        (self as *const CellHeader).offset(1) as *const u8
    }

    // Is this cell aligned to the given power-of-2 alignment?
    fn is_aligned_to<B: Into<Bytes>>(&self, align: B) -> bool {
        let align = align.into();
        extra_assert!(align.0.is_power_of_two());

        let data = unsafe { self.unchecked_data() } as usize;
        data & (align.0 - 1) == 0
    }
}

impl<'a> FreeCell<'a> {
    // Low bits in `FreeCell::next_free_raw`.
    //
    // If `NEXT_FREE_CELL_CAN_MERGE` is set, then the following invariants hold
    // true:
    //
    // * `FreeCell::next_free_raw` (and'd with the mask) is not null.
    // * `FreeCell::next_free_raw` is the adjacent `CellHeader::prev_cell_raw`.
    //
    // Therefore, this free cell can be merged into a single, larger, contiguous
    // free cell with its previous neighbor, which is also the next cell in the
    // free list.
    const NEXT_FREE_CELL_CAN_MERGE: usize = 0b01;
    const _RESERVED: usize = 0b10;
    const MASK: usize = !0b11;

    #[inline]
    fn next_free_bits(raw: *const FreeCell<'a>) -> usize {
        raw.addr() & !Self::MASK
    }

    #[inline]
    fn next_free_without_bits(raw: *const FreeCell<'a>) -> *const FreeCell<'a> {
        raw.map_addr(|addr| addr & Self::MASK)
    }

    #[inline]
    fn next_free_with_bits(raw: *const FreeCell<'a>, bits: usize) -> *const FreeCell<'a> {
        extra_assert_eq!(bits & Self::MASK, 0);
        raw.map_addr(|addr| (addr & Self::MASK) | bits)
    }

    fn next_free_can_merge(&self) -> bool {
        Self::next_free_bits(self.next_free_raw.get()) & Self::NEXT_FREE_CELL_CAN_MERGE != 0
    }

    fn clear_next_free_can_merge(&self) {
        let next_free = self.next_free_raw.get();
        let bits = Self::next_free_bits(next_free) & !Self::NEXT_FREE_CELL_CAN_MERGE;
        self.next_free_raw
            .set(Self::next_free_with_bits(next_free, bits));
    }

    fn next_free(&self) -> *const FreeCell<'a> {
        Self::next_free_without_bits(self.next_free_raw.get())
    }

    unsafe fn from_uninitialized(
        raw: NonNull<u8>,
        size: Bytes,
        next_free: Option<*const FreeCell<'a>>,
        policy: &dyn AllocPolicy<'a>,
    ) -> *const FreeCell<'a> {
        assert_is_word_aligned(raw.as_ptr());

        let next_free = next_free.unwrap_or(ptr::null_mut());

        let raw = raw.as_ptr() as *mut FreeCell;
        ptr::write(
            raw,
            FreeCell {
                header: CellHeader::default(),
                next_free_raw: Cell::new(next_free),
            },
        );

        write_free_pattern(raw, size, policy);

        raw
    }

    #[allow(clippy::wrong_self_convention)]
    unsafe fn into_allocated_cell(
        cell: *const FreeCell<'a>,
        policy: &dyn AllocPolicy<'a>,
    ) -> *const AllocatedCell<'a> {
        assert_local_cell_invariants(&(*cell).header);
        assert_is_poisoned_with_free_pattern(cell, policy);

        CellHeader::set_allocated(&(*cell).header.neighbors);
        cell as *const AllocatedCell<'a>
    }

    // Try and satisfy the given allocation request with this cell.
    fn try_alloc<'b>(
        cell: *const FreeCell<'a>,
        previous: &'b Cell<*const FreeCell<'a>>,
        alloc_size: Words,
        align: Bytes,
        policy: &dyn AllocPolicy<'a>,
    ) -> Option<*const AllocatedCell<'a>> {
        let free = unsafe { &*cell };
        extra_assert!(alloc_size.0 > 0);
        extra_assert!(align.0 > 0);
        extra_assert!(align.0.is_power_of_two());

        // First, do a quick check that this cell can hold an allocation of the
        // requested size.
        let size: Bytes = alloc_size.into();
        if free.header.size() < size {
            return None;
        }

        // Next, try and allocate by splitting this cell in two, and returning
        // the second half.
        //
        // We allocate from the end of this cell, rather than the beginning,
        // because it allows us to satisfy alignment requests. Since we can
        // choose to split at some alignment and return the aligned cell at the
        // end.
        let next = free.header.neighbors.next_unchecked().addr();
        let split_and_aligned = (next - size.0) & !(align.0 - 1);
        let data = unsafe { free.header.unchecked_data() }.addr();
        let min_cell_size: Bytes = policy.min_cell_size(alloc_size).into();
        if data + size_of::<CellHeader>().0 + min_cell_size.0 <= split_and_aligned {
            let split_cell_head = split_and_aligned - size_of::<CellHeader>().0;
            let split_cell = unsafe {
                let split_cell_ptr = (cell as *const u8).map_addr(|_| split_cell_head) as *mut u8;
                FreeCell::from_uninitialized(
                    unchecked_unwrap(NonNull::new(split_cell_ptr)),
                    Bytes(next - split_cell_head) - size_of::<CellHeader>(),
                    None,
                    policy,
                )
            };

            unsafe {
                Neighbors::append_raw(
                    cell as *const CellHeader<'a>,
                    split_cell as *const CellHeader<'a>,
                );
            }
            free.clear_next_free_can_merge();
            if CellHeader::next_cell_is_invalid(&free.header.neighbors) {
                CellHeader::clear_next_cell_is_invalid(&free.header.neighbors);
                unsafe {
                    CellHeader::set_next_cell_is_invalid(&(*split_cell).header.neighbors);
                }
            }

            return Some(unsafe { FreeCell::into_allocated_cell(split_cell, policy) });
        }

        // There isn't enough room to split this cell and still satisfy the
        // requested allocation. Because of the early check, we know this cell
        // is large enough to fit the requested size, but is the cell's data
        // properly aligned?
        if free.header.is_aligned_to(align) {
            previous.set(free.next_free());
            let allocated = unsafe { FreeCell::into_allocated_cell(cell, policy) };
            assert_is_valid_free_list(previous.get(), policy);
            return Some(allocated);
        }

        None
    }

    fn insert_into_free_list<'b>(
        cell: *const FreeCell<'a>,
        head: &'b Cell<*const FreeCell<'a>>,
        policy: &dyn AllocPolicy<'a>,
    ) -> &'b Cell<*const FreeCell<'a>> {
        let cell_ref = unsafe { &*cell };
        extra_assert!(!cell_ref.next_free_can_merge());
        extra_assert!(cell_ref.next_free().is_null());
        cell_ref.next_free_raw.set(head.get());
        head.set(cell);
        assert_is_valid_free_list(head.get(), policy);
        head
    }

    #[cfg(feature = "extra_assertions")]
    unsafe fn tail_data(cell: *const FreeCell<'a>) -> *const u8 {
        let data = (cell as *const u8).add(size_of::<FreeCell>().0);
        assert_is_word_aligned(data);
        data
    }

    #[cfg(feature = "extra_assertions")]
    fn tail_data_size(&self) -> Bytes {
        let size = self.header.size();
        extra_assert!(size >= size_of::<usize>());
        // Subtract a word from the size, since `FreeCell::next_free` uses it.
        size - size_of::<usize>()
    }
}

unsafe fn allocated_cell_data<'a>(cell: *const AllocatedCell<'a>) -> *const u8 {
    let cell_header = cell as *const CellHeader<'a>;
    assert_local_cell_invariants(cell_header);
    (cell as *const u8).add(size_of::<AllocatedCell>().0)
}

unsafe fn allocated_cell_into_free_cell<'a>(
    cell: *const AllocatedCell<'a>,
    policy: &dyn AllocPolicy<'a>,
) -> *const FreeCell<'a> {
    assert_local_cell_invariants(cell as *const CellHeader);

    CellHeader::set_free(&(*cell).header.neighbors);
    let free = cell as *const FreeCell<'a>;
    write_free_pattern(free, (*free).header.size(), policy);
    (*free).next_free_raw.set(ptr::null_mut());
    free
}

extra_only! {
    fn write_free_pattern(cell: *const FreeCell, size: Bytes, policy: &dyn AllocPolicy) {
        unsafe {
            let data = FreeCell::tail_data(cell);
            let pattern = policy.free_pattern();
            ptr::write_bytes(
                data as *mut u8,
                pattern,
                (size - (size_of::<FreeCell>() - size_of::<CellHeader>())).0
            );
        }
    }
}

extra_only! {
    fn assert_is_poisoned_with_free_pattern(cell: *const FreeCell, policy: &dyn AllocPolicy) {
        use core::slice;
        unsafe {
            let size: Bytes = (*cell).tail_data_size();
            let data = FreeCell::tail_data(cell);
            let data = slice::from_raw_parts(data, size.0);
            let pattern = policy.free_pattern();
            extra_assert!(data.iter().all(|byte| *byte == pattern));
        }
    }
}

extra_only! {
    fn assert_local_cell_invariants(cell: *const CellHeader) {
        assert_is_word_aligned(cell);
        unsafe {
            if let Some(cell_ref) = cell.as_ref() {
                assert!(cell_ref.size() >= size_of::<usize>());

                if let Some(prev) = cell_ref.neighbors.prev() {
                    assert!(prev.size() >= size_of::<usize>());
                    assert!(!CellHeader::next_cell_is_invalid(&prev.neighbors));
                    assert_eq!(prev.neighbors.next_unchecked(), cell, "next(prev(cell)) == cell");
                }

                if let Some(next) = cell_ref.neighbors.next() {
                    assert!(next.size() >= size_of::<usize>());
                    assert_eq!(next.neighbors.prev_unchecked(), cell, "prev(next(cell)) == cell");
                }
            }
        }
    }
}

extra_only! {
    fn assert_local_free_cell_invariants(free: *const FreeCell) {
        assert_local_cell_invariants(free as *const CellHeader);
        unsafe {
            if free.is_null() {
                return;
            }

            if (*free).next_free_can_merge() {
                let prev_cell = (*free).header.neighbors.prev().expect(
                    "if the next free cell (aka prev_cell) can merge, \
                     prev_cell had better exist"
                );
                assert!(
                    prev_cell.is_free(),
                    "prev_cell is free, when NEXT_FREE_CELL_CAN_MERGE bit is set"
                );
                assert_eq!(
                    (*free).next_free() as *const CellHeader,
                    prev_cell as *const _,
                    "next_free == prev_cell, when NEXT_FREE_CAN_MERGE bit is set"
                );
            }
        }
    }
}

extra_only! {
    // Assert global invariants of the given free list:
    //
    // - The free list does not have cycles
    //
    // - None of the cells within the free list are marked allocated
    //
    // - The freed cell's data is properly poisoned, i.e. there has not been any
    //   use-after-free.
    //
    // This is O(size of free list) and can be pretty slow, so try to restrict
    // its usage to verifying that a free list is still valid after mutation.
    fn assert_is_valid_free_list(head: *const FreeCell, policy: &dyn AllocPolicy) {
        unsafe {
            let mut left = head;
            assert_local_free_cell_invariants(left);
            if left.is_null() {
                return;
            }
            assert_is_poisoned_with_free_pattern(left, policy);

            let mut right = (*left).next_free();

            loop {
                assert_local_free_cell_invariants(right);
                if right.is_null() {
                    return;
                }
                assert_is_poisoned_with_free_pattern(right, policy);

                assert!(left != right, "free list should not have cycles");
                assert!((*right).header.is_free(), "cells in free list should never be allocated");
                assert!((*left).header.is_free(), "cells in free list should never be allocated");

                right = (*right).next_free();
                assert_local_free_cell_invariants(right);
                if right.is_null() {
                    return;
                }
                assert_is_poisoned_with_free_pattern(right, policy);

                left = (*left).next_free();
                assert_local_free_cell_invariants(left);
                assert_is_poisoned_with_free_pattern(left, policy);

                assert!(left != right, "free list should not have cycles");
                assert!((*right).header.is_free(), "cells in free list should never be allocated");
                assert!((*left).header.is_free(), "cells in free list should never be allocated");

                right = (*right).next_free();
            }
        }
    }
}

trait AllocPolicy<'a> {
    unsafe fn new_cell_for_free_list(
        &self,
        size: Words,
        align: Bytes,
    ) -> Result<*const FreeCell<'a>, AllocErr>;

    fn min_cell_size(&self, alloc_size: Words) -> Words;

    fn should_merge_adjacent_free_cells(&self) -> bool;

    #[cfg(feature = "extra_assertions")]
    fn free_pattern(&self) -> u8;
}

struct LargeAllocPolicy;
static LARGE_ALLOC_POLICY: LargeAllocPolicy = LargeAllocPolicy;

impl LargeAllocPolicy {
    #[cfg(feature = "size_classes")]
    const MIN_CELL_SIZE: Words = Words(size_classes::SizeClasses::NUM_SIZE_CLASSES * 2);

    #[cfg(not(feature = "size_classes"))]
    const MIN_CELL_SIZE: Words = Words(16);
}

impl<'a> AllocPolicy<'a> for LargeAllocPolicy {
    unsafe fn new_cell_for_free_list(
        &self,
        size: Words,
        align: Bytes,
    ) -> Result<*const FreeCell<'a>, AllocErr> {
        // To assure that an allocation will always succeed after refilling the
        // free list with this new cell, make sure that we allocate enough to
        // fulfill the requested alignment, and still have the minimum cell size
        // left over.
        let requested_size: Bytes = size.into();
        let size: Bytes = requested_size
            .0
            .checked_add(align.0)
            .and_then(|s| s.checked_add(size_of::<CellHeader>().0))
            .and_then(|s| s.checked_add(Bytes::from(Self::MIN_CELL_SIZE).0))
            .map(Bytes)
            .map(|s| cmp::max(requested_size, s))
            .ok_or_else(AllocErr::new)?;

        let pages: Pages = checked_round_up_to::<Pages>(size + size_of::<CellHeader>())
            .ok_or_else(AllocErr::new)?;
        let new_pages = imp::alloc_pages(pages)?;
        let allocated_size: Bytes = pages.into();

        let free_cell = FreeCell::from_uninitialized(
            new_pages,
            allocated_size - size_of::<CellHeader>(),
            None,
            self as &dyn AllocPolicy<'a>,
        );

        let next_cell = (new_pages.as_ptr() as *const u8).add(allocated_size.0);
        (*free_cell)
            .header
            .neighbors
            .set_next(next_cell as *const CellHeader);
        CellHeader::set_next_cell_is_invalid(&(*free_cell).header.neighbors);
        Ok(free_cell)
    }

    fn min_cell_size(&self, _alloc_size: Words) -> Words {
        Self::MIN_CELL_SIZE
    }

    fn should_merge_adjacent_free_cells(&self) -> bool {
        true
    }

    #[cfg(feature = "extra_assertions")]
    fn free_pattern(&self) -> u8 {
        CellHeader::LARGE_FREE_PATTERN
    }
}

#[inline]
unsafe fn unchecked_unwrap<T>(o: Option<T>) -> T {
    #[cfg(any(debug_assertions, feature = "extra_assertions"))]
    {
        o.unwrap()
    }
    #[cfg(not(any(debug_assertions, feature = "extra_assertions")))]
    {
        o.unwrap_unchecked()
    }
}

unsafe fn walk_free_list<'a, F, T>(
    head: &Cell<*const FreeCell<'a>>,
    policy: &dyn AllocPolicy<'a>,
    mut f: F,
) -> Result<T, AllocErr>
where
    F: FnMut(&Cell<*const FreeCell<'a>>, *const FreeCell<'a>) -> Option<T>,
{
    // The previous cell in the free list (not to be confused with the current
    // cell's previously _adjacent_ cell).
    let mut previous_free = head;

    loop {
        let current_free = previous_free.get();
        if current_free.is_null() {
            return Err(AllocErr::new());
        }

        assert_local_cell_invariants(&(*current_free).header);

        let current_free = Cell::new(current_free);

        // Now check if this cell can merge with the next cell in the free
        // list.
        //
        // We don't re-check `policy.should_merge_adjacent_free_cells()` because
        // the `NEXT_FREE_CELL_CAN_MERGE` bit only gets set after checking with
        // the policy.
        while (*current_free.get()).next_free_can_merge() {
            extra_assert!(policy.should_merge_adjacent_free_cells());

            let current = &*current_free.get();
            current.clear_next_free_can_merge();

            let prev_neighbor = unchecked_unwrap(current.header.neighbors.prev().and_then(|p| {
                let prev = current.header.neighbors.prev_unchecked();
                if p.is_free() {
                    Some(prev as *const FreeCell<'a>)
                } else {
                    None
                }
            }));

            current.header.neighbors.remove();
            if CellHeader::next_cell_is_invalid(&current.header.neighbors) {
                CellHeader::set_next_cell_is_invalid(&(*prev_neighbor).header.neighbors);
            }

            previous_free.set(prev_neighbor);
            current_free.set(prev_neighbor);

            write_free_pattern(
                current_free.get(),
                (*current_free.get()).header.size(),
                policy,
            );
            assert_local_cell_invariants(&(*current_free.get()).header);
        }

        if let Some(result) = f(previous_free, current_free.get()) {
            return Ok(result);
        }

        previous_free = &(*current_free.get()).next_free_raw;
    }
}

/// Find the logical free-list link that currently points at `target`.
///
/// Parameters:
/// - `head`: head pointer cell for the logical free list.
/// - `target`: the free-cell header that must already be reachable from `head`.
/// - `policy`: allocation policy for this list; `walk_free_list` needs it because
///   it may resolve pending delayed merges while searching.
///
/// Returns:
/// - `Ok(slot)` where `(*slot).get() == target` after any pending delayed merges
///   on the walk path are resolved.
/// - `Err(AllocErr)` if `target` is not reachable from `head`.
unsafe fn find_free_list_slot<'a>(
    head: &Cell<*const FreeCell<'a>>,
    target: *const FreeCell<'a>,
    policy: &dyn AllocPolicy<'a>,
) -> Result<*const Cell<*const FreeCell<'a>>, AllocErr> {
    walk_free_list(head, policy, |previous, current| {
        if ptr::eq(current, target) {
            Some(previous as *const Cell<*const FreeCell<'a>>)
        } else {
            None
        }
    })
}

/// Do a first-fit allocation from the given free list.
unsafe fn alloc_first_fit<'a>(
    size: Words,
    align: Bytes,
    head: &Cell<*const FreeCell<'a>>,
    policy: &dyn AllocPolicy<'a>,
) -> Result<NonNull<u8>, AllocErr> {
    extra_assert!(size.0 > 0);

    walk_free_list(head, policy, |previous, current| {
        extra_assert_eq!(previous.get(), current);

        if let Some(allocated) = FreeCell::try_alloc(current, previous, size, align, policy) {
            let data = unsafe { allocated_cell_data(allocated) };
            assert_aligned_to(data, align);
            return Some(unchecked_unwrap(NonNull::new(data as *mut u8)));
        }

        None
    })
}

unsafe fn alloc_with_refill<'a>(
    size: Words,
    align: Bytes,
    head: &Cell<*const FreeCell<'a>>,
    policy: &dyn AllocPolicy<'a>,
) -> Result<NonNull<u8>, AllocErr> {
    if let Ok(result) = alloc_first_fit(size, align, head, policy) {
        return Ok(result);
    }

    let cell = policy.new_cell_for_free_list(size, align)?;
    let head = FreeCell::insert_into_free_list(cell, head, policy);

    let result = alloc_first_fit(size, align, head, policy);
    extra_assert!(
        result.is_ok(),
        "if refilling the free list succeeds, then retrying the allocation \
         should also always succeed"
    );
    result
}

#[cfg(feature = "instrumentation")]
/// Statistics about the allocator's internal state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AllocStats {
    /// The number of cells in the main free list.
    pub free_list_count: usize,
    /// The total number of bytes in all free lists.
    pub total_free_bytes: usize,
    /// The number of cells in the size class free lists.
    pub size_class_free_list_count: usize,
}

/// A wee allocator.
///
/// # Safety
///
/// Valid only on a single non-shared Wasm instance without reentrant allocator calls.
pub struct WeeAlloc<'a> {
    head: imp::Exclusive<*const FreeCell<'a>>,

    #[cfg(feature = "size_classes")]
    size_classes: size_classes::SizeClasses<'a>,
}

unsafe impl<'a> Sync for WeeAlloc<'a> {}

impl<'a> ConstInit for WeeAlloc<'a> {
    const INIT: WeeAlloc<'a> = WeeAlloc {
        head: <imp::Exclusive<*const FreeCell<'a>> as ConstInit>::INIT,

        #[cfg(feature = "size_classes")]
        size_classes: size_classes::SizeClasses::INIT,
    };
}

impl<'a> WeeAlloc<'a> {
    #[cfg(feature = "instrumentation")]
    /// Returns statistics about the allocator's internal state.
    pub fn stats(&self) -> AllocStats {
        let mut stats = AllocStats::default();
        unsafe {
            self.head.with_exclusive_access(|head| {
                let mut current = *head;
                while !current.is_null() {
                    stats.free_list_count += 1;
                    stats.total_free_bytes += (*current).header.size().0;
                    current = (*current).next_free();
                }
            });

            #[cfg(feature = "size_classes")]
            {
                for i in 1..=size_classes::SizeClasses::NUM_SIZE_CLASSES {
                    if let Some(head) = self.size_classes.get(Words(i)) {
                        head.with_exclusive_access(|head| {
                            let mut current = *head;
                            while !current.is_null() {
                                stats.size_class_free_list_count += 1;
                                stats.total_free_bytes += (*current).header.size().0;
                                current = (*current).next_free();
                            }
                        });
                    }
                }
            }
        }
        stats
    }

    /// An initial `const` default construction of a `WeeAlloc` allocator.
    ///
    /// This is usable for initializing `static`s that get set as the global
    /// allocator.
    #[allow(clippy::declare_interior_mutable_const)]
    pub const INIT: Self = <Self as ConstInit>::INIT;

    #[cfg(feature = "size_classes")]
    unsafe fn with_free_list_and_policy_for_size<F, T>(&self, size: Words, align: Bytes, f: F) -> T
    where
        F: for<'b> FnOnce(&'b Cell<*const FreeCell<'a>>, &'b dyn AllocPolicy<'a>) -> T,
    {
        extra_assert!(size.0 > 0);
        extra_assert!(align.0 > 0);

        if align <= size_of::<usize>() {
            if let Some(head) = self.size_classes.get(size) {
                let policy = size_classes::SizeClassAllocPolicy(&self.head);
                let policy = &policy as &dyn AllocPolicy<'a>;
                return head.with_exclusive_access(|head| {
                    let head_cell = Cell::new(*head);
                    let result = f(&head_cell, policy);
                    *head = head_cell.get();
                    result
                });
            }
        }

        let policy = &LARGE_ALLOC_POLICY as &dyn AllocPolicy<'a>;
        self.head.with_exclusive_access(|head| {
            let head_cell = Cell::new(*head);
            let result = f(&head_cell, policy);
            *head = head_cell.get();
            result
        })
    }

    #[cfg(not(feature = "size_classes"))]
    unsafe fn with_free_list_and_policy_for_size<F, T>(&self, size: Words, _align: Bytes, f: F) -> T
    where
        F: for<'b> FnOnce(&'b Cell<*const FreeCell<'a>>, &'b dyn AllocPolicy<'a>) -> T,
    {
        extra_assert!(size.0 > 0);
        let policy = &LARGE_ALLOC_POLICY as &dyn AllocPolicy;
        self.head.with_exclusive_access(|head| {
            let head_cell = Cell::new(*head);
            let result = f(&head_cell, policy);
            *head = head_cell.get();
            result
        })
    }

    unsafe fn alloc_impl(&self, layout: Layout) -> Result<NonNull<u8>, AllocErr> {
        let size = Bytes(layout.size());
        let align = if layout.align() == 0 {
            Bytes(1)
        } else {
            Bytes(layout.align())
        };

        if size.0 == 0 {
            // Ensure that our made up pointer is properly aligned by using the
            // alignment as the pointer.
            extra_assert!(align.0 > 0);
            return Ok(NonNull::new_unchecked(align.0 as *mut u8));
        }

        let word_size: Words = checked_round_up_to(size).ok_or_else(AllocErr::new)?;

        self.with_free_list_and_policy_for_size(word_size, align, |head, policy| {
            assert_is_valid_free_list(head.get(), policy);
            alloc_with_refill(word_size, align, head, policy)
        })
    }

    unsafe fn dealloc_impl(&self, ptr: NonNull<u8>, layout: Layout) {
        let size = Bytes(layout.size());
        if size.0 == 0 {
            return;
        }

        let size: Words = size.round_up_to();
        let align = Bytes(layout.align());

        self.with_free_list_and_policy_for_size(size, align, |head, policy| {
            let cell = (ptr.as_ptr() as *mut CellHeader<'a> as *const CellHeader<'a>).offset(-1);

            extra_assert!((*cell).size() >= size.into());
            extra_assert!((*cell).is_allocated());
            let cell = cell as *const AllocatedCell<'a>;

            let free = allocated_cell_into_free_cell(cell, policy);

            if policy.should_merge_adjacent_free_cells() {
                let next_slot =
                    match (*free)
                        .header
                        .neighbors
                        .next()
                        .and_then(|n: &CellHeader<'a>| {
                            let next = (*free).header.neighbors.next_unchecked();
                            if n.is_free() {
                                Some(next as *const FreeCell<'a>)
                            } else {
                                None
                            }
                        }) {
                        Some(next) => {
                            let slot = match find_free_list_slot(head, next as *const _, policy) {
                                Ok(slot) => slot,
                                Err(_) => unreachable!(
                                    "adjacent free cell must already be in the free list"
                                ),
                            };
                            Some(&*slot)
                        }
                        None => None,
                    };

                // The search above may have resolved older delayed merges.
                let prev = (*free)
                    .header
                    .neighbors
                    .prev()
                    .and_then(|p: &CellHeader<'a>| {
                        let prev = (*free).header.neighbors.prev_unchecked();
                        if p.is_free() {
                            Some(prev as *const FreeCell<'a>)
                        } else {
                            None
                        }
                    });

                let next = (*free)
                    .header
                    .neighbors
                    .next()
                    .and_then(|n: &CellHeader<'a>| {
                        let next = (*free).header.neighbors.next_unchecked();
                        if n.is_free() {
                            Some(next as *const FreeCell<'a>)
                        } else {
                            None
                        }
                    });

                match (prev, next, next_slot) {
                    // Full eager three-way merge: prev + free + next
                    (Some(prev), Some(next), Some(next_slot)) => {
                        extra_assert!(!(*next).next_free_can_merge());

                        // Remove `next` from the logical free list first.
                        next_slot.set((*next).next_free());

                        // Remove `free` from the physical neighbors list, making prev adjacent to next.
                        (*free).header.neighbors.remove();

                        // If `next` was the terminal cell, the merged `prev` becomes terminal.
                        if CellHeader::next_cell_is_invalid(&(*next).header.neighbors) {
                            CellHeader::set_next_cell_is_invalid(&(*prev).header.neighbors);
                        }

                        // Remove `next` from the physical neighbors list too.
                        (*next).header.neighbors.remove();

                        write_free_pattern(prev, (*prev).header.size(), policy);
                        assert_is_valid_free_list(head.get(), policy);
                        return;
                    }

                    // Existing fast path: merge only with prev.
                    (Some(prev), None, None) => {
                        (*free).header.neighbors.remove();
                        if CellHeader::next_cell_is_invalid(&(*free).header.neighbors) {
                            CellHeader::set_next_cell_is_invalid(&(*prev).header.neighbors);
                        }

                        write_free_pattern(prev, (*prev).header.size(), policy);
                        assert_is_valid_free_list(head.get(), policy);
                        return;
                    }

                    // New eager two-way merge: free + next
                    (None, Some(next), Some(next_slot)) => {
                        extra_assert!(!(*next).next_free_can_merge());

                        // Replace `next` with `free` in the logical free list.
                        (*free).next_free_raw.set((*next).next_free());
                        next_slot.set(free);

                        if CellHeader::next_cell_is_invalid(&(*next).header.neighbors) {
                            CellHeader::set_next_cell_is_invalid(&(*free).header.neighbors);
                        }

                        // Remove `next` physically; `free` remains the surviving header.
                        (*next).header.neighbors.remove();

                        write_free_pattern(free, (*free).header.size(), policy);
                        assert_is_valid_free_list(head.get(), policy);
                        return;
                    }

                    (None, None, None) => {}
                    _ => unreachable!("neighbor snapshot changed unexpectedly"),
                }
            }

            // Either we don't want to merge cells for the current policy, or we
            // didn't have the opportunity to do any merging with our adjacent
            // neighbors. In either case, push this cell onto the front of the
            // free list.
            let _head = FreeCell::insert_into_free_list(free, head, policy);
        });
    }
}

unsafe impl GlobalAlloc for WeeAlloc<'static> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        match self.alloc_impl(layout) {
            Ok(ptr) => ptr.as_ptr(),
            Err(_) => ptr::null_mut(),
        }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if let Some(ptr) = NonNull::new(ptr) {
            self.dealloc_impl(ptr, layout);
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "instrumentation")]
    use super::*;

    #[cfg(feature = "instrumentation")]
    const fn reduce_for_miri(base: usize, factor: usize) -> usize {
        if cfg!(miri) {
            let reduced = base / factor;
            if reduced == 0 {
                1
            } else {
                reduced
            }
        } else {
            base
        }
    }

    #[test]
    #[cfg(feature = "instrumentation")]
    fn test_merge_free_left_free_right_then_free_middle() {
        #[cfg(not(target_arch = "wasm32"))]
        let _arena = crate::imp::scope();
        let alloc = WeeAlloc::INIT;
        let layout = Layout::from_size_align(100, 1).unwrap();

        unsafe {
            let left = alloc.alloc_impl(layout).unwrap();
            let middle = alloc.alloc_impl(layout).unwrap();
            let right = alloc.alloc_impl(layout).unwrap();

            alloc.dealloc_impl(left, layout);
            alloc.dealloc_impl(right, layout);
            alloc.dealloc_impl(middle, layout);

            let stats = alloc.stats();
            assert_eq!(stats.free_list_count, 1);
        }
    }

    #[test]
    #[cfg(feature = "instrumentation")]
    fn test_merge_free_right_then_free_left() {
        #[cfg(not(target_arch = "wasm32"))]
        let _arena = crate::imp::scope();
        let alloc = WeeAlloc::INIT;
        let layout = Layout::from_size_align(100, 1).unwrap();

        unsafe {
            let left = alloc.alloc_impl(layout).unwrap();
            let right = alloc.alloc_impl(layout).unwrap();

            alloc.dealloc_impl(right, layout);
            alloc.dealloc_impl(left, layout);

            let stats = alloc.stats();
            assert_eq!(stats.free_list_count, 1);
        }
    }

    #[test]
    #[cfg(feature = "instrumentation")]
    fn test_leak() {
        #[cfg(not(target_arch = "wasm32"))]
        let _arena = crate::imp::scope();
        let test_cases = [
            (85196, 80000),
            (8190, 8191),
            (8190, 8190),
            (8192, 8189),
            (8192, 8188),
            (8193, 8188),
            (9193, 7188),
            (9192, 7188),
            (14193, 2188),
            (16281, 100),
            (16181, 200),
            (16081, 300),
        ];

        for (size_a, size_b) in test_cases {
            let alloc = WeeAlloc::INIT;
            let start_stats = alloc.stats();

            for _ in 0..reduce_for_miri(1000, 100) {
                let layout_a = Layout::from_size_align(size_a, 1).unwrap();
                let layout_b = Layout::from_size_align(size_b, 1).unwrap();

                unsafe {
                    let a = alloc
                        .alloc_impl(core::hint::black_box(layout_a))
                        .expect("allocation a failed");
                    let b = alloc
                        .alloc_impl(core::hint::black_box(layout_b))
                        .expect("allocation b failed");
                    alloc.dealloc_impl(core::hint::black_box(a), core::hint::black_box(layout_a));
                    alloc.dealloc_impl(core::hint::black_box(b), core::hint::black_box(layout_b));
                }
            }

            let end_stats = alloc.stats();

            assert!(
                end_stats.total_free_bytes >= start_stats.total_free_bytes,
                "Total free bytes should not decrease for sizes ({}, {}). Start: {:?}, End: {:?}",
                size_a,
                size_b,
                start_stats,
                end_stats
            );

            assert!(
                end_stats.free_list_count < start_stats.free_list_count + 10,
                "Free list count grew too much for sizes ({}, {}), possible leak or fragmentation. Start: {:?}, End: {:?}",
                size_a,
                size_b,
                start_stats,
                end_stats
            );
        }
    }
}

#[cfg(test)]
mod regression;

/// Small single-agent allocator for non-shared wasm32 memory.
/// Derived from wee_alloc; the implementation remains MPL-2.0.
pub type Allocator = WeeAlloc<'static>;
