// Appended to an unchanged allocator lib.rs in the generated verification crate.
#[cfg(kani)]
mod kani_proofs {
    use super::*;
    use core::alloc::{GlobalAlloc, Layout};
    unsafe fn seed(a: &WeeAlloc, storage: &mut [usize; 64]) {
        let raw = storage.as_mut_ptr().cast::<u8>();
        let cell = FreeCell::from_uninitialized(
            NonNull::new(raw).unwrap(),
            Bytes(512) - size_of::<CellHeader>(),
            None,
            &LARGE_ALLOC_POLICY,
        );
        (*cell).header.neighbors.set_next(raw.add(512).cast());
        CellHeader::set_next_cell_is_invalid(&(*cell).header.neighbors);
        a.head.with_exclusive_access(|head| *head = cell);
    }
    #[kani::proof]
    fn checked_rounding_all_usize_values() {
        let b: usize = kani::any();
        let result = checked_round_up_to::<Words>(Bytes(b));
        let unit = Words::BYTE_SIZE.0;
        if let Some(words) = result {
            let bytes: Bytes = words.into();
            assert!(bytes.0 >= b);
            assert!(bytes.0 - b < unit);
            assert_eq!(bytes.0 % unit, 0);
        } else {
            assert!(b > usize::MAX - unit);
        }
    }
    #[kani::proof]
    #[kani::unwind(4)]
    fn two_live_allocations_preserve_payload_and_alignment() {
        let a = WeeAlloc::INIT;
        let mut storage = [0usize; 64];
        unsafe {
            seed(&a, &mut storage);
        }
        let size_a: usize = 17;
        let size_b: usize = 33;
        let shift: u8 = 4;
        let marker: u8 = kani::any();
        let la = Layout::from_size_align(size_a, 1usize << shift).unwrap();
        let lb = Layout::from_size_align(size_b, 1usize << shift).unwrap();
        unsafe {
            let p = a.alloc(la);
            let q = a.alloc(lb);
            assert!(!p.is_null() && !q.is_null());
            assert_eq!(p.addr() % la.align(), 0);
            assert_eq!(q.addr() % lb.align(), 0);
            assert!(p.addr() + size_a <= q.addr() || q.addr() + size_b <= p.addr());
            *p = marker;
            *q = marker ^ 255;
            assert_eq!(*p, marker);
            assert_eq!(*q, marker ^ 255);
            if kani::any() {
                a.dealloc(p, la);
                assert_eq!(*q, marker ^ 255);
                a.dealloc(q, lb);
            } else {
                a.dealloc(q, lb);
                assert_eq!(*p, marker);
                a.dealloc(p, la);
            }
        }
    }
    #[kani::proof]
    #[kani::unwind(4)]
    fn adjacent_frees_coalesce_in_both_orders() {
        let a = WeeAlloc::INIT;
        let mut storage = [0usize; 64];
        unsafe {
            seed(&a, &mut storage);
        }
        let layout = Layout::from_size_align(100, 8).unwrap();
        unsafe {
            let p = a.alloc(layout);
            let q = a.alloc(layout);
            assert!(!p.is_null() && !q.is_null());
            if kani::any() {
                a.dealloc(p, layout);
                a.dealloc(q, layout);
            } else {
                a.dealloc(q, layout);
                a.dealloc(p, layout);
            }
            let before = crate::imp::used();
            let large = Layout::from_size_align(400, 8).unwrap();
            let r = a.alloc(large);
            assert!(!r.is_null());
            assert_eq!(
                crate::imp::used(),
                before,
                "reuse merged block without growing arena"
            );
            a.dealloc(r, large);
        }
    }
}
#[cfg(kani)]
mod kani_boundary_proofs {
    use super::*;
    #[kani::proof]
    #[kani::unwind(3)]
    fn valid_layouts_return_null_on_refill_oom_without_overflow() {
        let size: usize = kani::any();
        let shift: u8 = kani::any();
        kani::assume(size > 0 && shift <= 16);
        if let Ok(layout) = Layout::from_size_align(size, 1usize << shift) {
            let allocator = WeeAlloc::INIT;
            assert!(unsafe { allocator.alloc(layout) }.is_null());
        }
    }
    #[kani::proof]
    fn neighbor_tag_bits_preserve_every_aligned_u32_address() {
        let addr: u32 = kani::any();
        kani::assume(addr & 3 == 0);
        let bits: u8 = kani::any();
        kani::assume(bits < 4);
        let n = Neighbors::<CellHeader>::default();
        let p = ptr::without_provenance(addr as usize);
        unsafe {
            n.set_next(p);
        }
        if bits & 1 != 0 {
            n.set_next_bit_1();
        }
        if bits & 2 != 0 {
            n.set_next_bit_2();
        }
        assert_eq!(n.next_unchecked().addr(), addr as usize);
        assert_eq!(n.get_next_bit_1(), bits & 1 != 0);
        assert_eq!(n.get_next_bit_2(), bits & 2 != 0);
    }
}
