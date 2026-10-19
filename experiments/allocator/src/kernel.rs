//! Identical guest workload for every allocator. One exported call batches jobs.
use alloc::alloc::{alloc, dealloc, realloc};
use core::{alloc::Layout, hint::black_box, ptr};

fn marker(seed: &mut u32) -> u8 {
    *seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
    *seed as u8
}
unsafe fn allocate(layout: Layout) -> *mut u8 {
    let p = unsafe { alloc(black_box(layout)) };
    assert!(!p.is_null(), "allocator OOM");
    assert_eq!(p.addr() % layout.align(), 0, "alignment");
    black_box(p)
}
unsafe fn stamp(p: *mut u8, size: usize, value: u8, verify: bool) {
    if verify {
        unsafe {
            ptr::write_bytes(p, value, size);
        }
    } else {
        unsafe {
            p.write_volatile(value);
            p.add(size - 1).write_volatile(value);
        }
    }
}
unsafe fn check(p: *mut u8, size: usize, value: u8, verify: bool) -> u32 {
    if verify {
        for i in 0..size {
            assert_eq!(unsafe { *p.add(i) }, value, "payload");
        }
    }
    let first = unsafe { p.read_volatile() };
    assert_eq!(unsafe { p.add(size - 1).read_volatile() }, first, "tail");
    first as u32
}
unsafe fn distinct(p: *mut u8, size: usize, other: *mut u8, other_size: usize) {
    assert!(
        p.addr() + size <= other.addr() || other.addr() + other_size <= p.addr(),
        "overlap"
    );
}

pub fn run(case: u32, rounds: u32, mut seed: u32, verify: bool) -> u32 {
    assert!(case <= 7, "unknown workload");
    if case == 0 {
        return seed;
    }
    let mut sum = 0u32;
    for _ in 0..rounds {
        match case {
            1..=3 => {
                let (size, align) = match case {
                    1 => (32, 8),
                    2 => (1024, 16),
                    _ => (64, 4096),
                };
                let layout = Layout::from_size_align(size, align).unwrap();
                let value = marker(&mut seed);
                unsafe {
                    let p = allocate(layout);
                    stamp(p, size, value, verify);
                    sum = sum.wrapping_add(check(p, size, value, verify));
                    dealloc(p, layout);
                }
            }
            4..=6 => {
                let mut pointers = [ptr::null_mut(); 32];
                let mut sizes = [0usize; 32];
                let mut values = [0u8; 32];
                for i in 0..32 {
                    let size = if case == 6 { 24usize << (i % 6) } else { 96 };
                    sizes[i] = size;
                    values[i] = marker(&mut seed);
                    let layout = Layout::from_size_align(size, 8).unwrap();
                    unsafe {
                        let p = allocate(layout);
                        if verify {
                            for j in 0..i {
                                distinct(p, size, pointers[j], sizes[j]);
                            }
                        }
                        stamp(p, size, values[i], verify);
                        pointers[i] = p;
                    }
                }
                for step in 0..32 {
                    let i = if case == 5 { 31 - step } else { step };
                    let size = sizes[i];
                    let layout = Layout::from_size_align(size, 8).unwrap();
                    unsafe {
                        let mut p = pointers[i];
                        if case == 6 {
                            let q = realloc(black_box(p), layout, black_box(size * 2 + 7));
                            assert!(!q.is_null());
                            assert_eq!(q.addr() % 8, 0);
                            if verify {
                                for j in i + 1..32 {
                                    distinct(q, size * 2 + 7, pointers[j], sizes[j]);
                                }
                            }
                            p = q;
                        }
                        sum = sum.wrapping_add(check(p, size, values[i], verify));
                        let final_size = if case == 6 { size * 2 + 7 } else { size };
                        dealloc(
                            black_box(p),
                            Layout::from_size_align(final_size, 8).unwrap(),
                        );
                    }
                }
            }
            7 => {
                let layout = Layout::from_size_align(20000, 8).unwrap();
                let mut pointers = [ptr::null_mut(); 3];
                let mut values = [0u8; 3];
                for i in 0..3 {
                    values[i] = marker(&mut seed);
                    unsafe {
                        let p = allocate(layout);
                        if verify {
                            for &other in pointers.iter().take(i) {
                                distinct(p, 20000, other, 20000);
                            }
                        }
                        stamp(p, 20000, values[i], verify);
                        pointers[i] = p;
                    }
                }
                for step in 0..3 {
                    let i = if seed & 1 == 0 { step } else { 2 - step };
                    unsafe {
                        sum = sum.wrapping_add(check(pointers[i], 20000, values[i], verify));
                        dealloc(pointers[i], layout);
                    }
                }
                let layout = Layout::from_size_align(60000, 8).unwrap();
                let value = marker(&mut seed);
                unsafe {
                    let p = allocate(layout);
                    stamp(p, 60000, value, verify);
                    sum = sum.wrapping_add(check(p, 60000, value, verify));
                    dealloc(p, layout);
                }
            }
            _ => unreachable!(),
        }
    }
    sum
}
