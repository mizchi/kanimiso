use super::*;

#[cfg(feature = "realloc_in_place")]
#[test]
fn realloc_within_one_word_keeps_pointer_and_payload() {
    #[cfg(not(target_arch = "wasm32"))]
    let _arena = crate::imp::scope();
    let a = WeeAlloc::INIT;
    let word = core::mem::size_of::<usize>();
    let mut size = word + 1;
    let mut layout = Layout::from_size_align(size, word).unwrap();
    unsafe {
        let mut p = a.alloc(layout);
        assert!(!p.is_null());
        ptr::write_bytes(p, 0xa5, size);
        for next in [word + 2, word + 1, word + 1, word * 2] {
            let address = p.addr();
            let q = a.realloc(p, layout, next);
            assert_eq!(q.addr(), address);
            for i in 0..size.min(next) {
                assert_eq!(*q.add(i), 0xa5);
            }
            ptr::write_bytes(q, 0xa5, next);
            p = q;
            size = next;
            layout = Layout::from_size_align(size, word).unwrap();
        }
        a.dealloc(p, layout);
    }
}

#[test]
fn alignment_zeroed_realloc_and_live_payloads() {
    #[cfg(not(target_arch = "wasm32"))]
    let _arena = crate::imp::scope();
    let a = WeeAlloc::INIT;
    for alignment in [1, 2, 4, 8, 16, 64, 256, 4096, 65536] {
        for size in [1, 3, 17, 129, 2049] {
            let layout = Layout::from_size_align(size, alignment).unwrap();
            unsafe {
                let p = a.alloc_zeroed(layout);
                assert!(!p.is_null());
                assert_eq!(p.addr() % alignment, 0);
                for i in 0..size {
                    assert_eq!(*p.add(i), 0);
                    *p.add(i) = (i as u8) ^ 0xa5;
                }
                let q = a.realloc(p, layout, size * 2 + 7);
                assert!(!q.is_null());
                assert_eq!(q.addr() % alignment, 0);
                for i in 0..size {
                    assert_eq!(*q.add(i), (i as u8) ^ 0xa5);
                }
                a.dealloc(q, Layout::from_size_align(size * 2 + 7, alignment).unwrap());
            }
        }
    }
}

#[cfg(feature = "realloc_in_place")]
#[test]
fn realloc_across_classes_preserves_live_neighbor() {
    #[cfg(not(target_arch = "wasm32"))]
    let _arena = crate::imp::scope();
    let a = WeeAlloc::INIT;
    let word = core::mem::size_of::<usize>();
    let guard_layout = Layout::from_size_align(64, word * 2).unwrap();
    unsafe {
        let guard = a.alloc(guard_layout);
        assert!(!guard.is_null());
        ptr::write_bytes(guard, 0x3c, guard_layout.size());
        for start in [1, word, word + 1, word * 32, word * 32 + 1] {
            let mut layout = Layout::from_size_align(start, word).unwrap();
            let mut p = a.alloc(layout);
            assert!(!p.is_null());
            ptr::write_bytes(p, 0xa5, start);
            for next in [start + word, 1, word * 33 + 1, start] {
                let q = a.realloc(p, layout, next);
                assert!(!q.is_null());
                assert_eq!(q.addr() % word, 0);
                for i in 0..layout.size().min(next) {
                    assert_eq!(*q.add(i), 0xa5);
                }
                for i in 0..guard_layout.size() {
                    assert_eq!(*guard.add(i), 0x3c);
                }
                ptr::write_bytes(q, 0xa5, next);
                p = q;
                layout = Layout::from_size_align(next, word).unwrap();
            }
            a.dealloc(p, layout);
        }
        a.dealloc(guard, guard_layout);
    }
}

#[test]
fn seeded_interleaved_allocations_preserve_live_bytes() {
    #[cfg(not(target_arch = "wasm32"))]
    let _arena = crate::imp::scope();
    let a = WeeAlloc::INIT;
    let mut live = [None; 32];
    let mut seed = 123u32;
    let iterations = if cfg!(miri) { 128 } else { 4096 };
    for _ in 0..iterations {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let index = (seed as usize >> 16) % live.len();
        unsafe {
            if let Some((p, layout, pattern)) = live[index].take() {
                let p: *mut u8 = p;
                let layout: Layout = layout;
                for j in 0..layout.size() {
                    assert_eq!(*p.add(j), pattern);
                }
                a.dealloc(p, layout);
            } else {
                let size = ((seed >> 8) % 2048 + 1) as usize;
                let layout = Layout::from_size_align(size, 1 << ((seed >> 24) % 7)).unwrap();
                let p = a.alloc(layout);
                assert!(!p.is_null());
                assert_eq!(p.addr() % layout.align(), 0);
                let pattern = seed as u8;
                ptr::write_bytes(p, pattern, size);
                live[index] = Some((p, layout, pattern));
            }
        }
    }
    for (p, l, pattern) in live.into_iter().flatten() {
        unsafe {
            for j in 0..l.size() {
                assert_eq!(*p.add(j), pattern);
            }
            a.dealloc(p, l);
        }
    }
}
