//! Requested live heap bytes, excluding allocator headers, fragmentation and
//! static task slots. Instrumented binaries are never used for size or timing.
use core::alloc::{GlobalAlloc, Layout};
use core::sync::atomic::{AtomicUsize, Ordering::Relaxed};
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
struct Counted(taraba_allocator::Allocator);
#[global_allocator]
static ALLOCATOR: Counted = Counted(taraba_allocator::Allocator::INIT);
fn add(bytes: usize) {
    let live = LIVE.fetch_add(bytes, Relaxed) + bytes;
    PEAK.fetch_max(live, Relaxed);
}
unsafe impl GlobalAlloc for Counted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { self.0.alloc(layout) };
        if !p.is_null() {
            add(layout.size())
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { self.0.dealloc(p, layout) };
        LIVE.fetch_sub(layout.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let next = unsafe { self.0.realloc(p, layout, size) };
        if !next.is_null() {
            LIVE.fetch_sub(layout.size(), Relaxed);
            add(size)
        }
        next
    }
}
pub fn live() -> u32 {
    LIVE.load(Relaxed) as u32
}
pub fn peak() -> u32 {
    PEAK.load(Relaxed) as u32
}
pub fn reset() {
    PEAK.store(LIVE.load(Relaxed), Relaxed)
}
