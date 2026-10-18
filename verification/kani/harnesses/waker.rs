// The production waker.rs is imported; only its target gate is expanded for kani.
static mut LAST: u32 = 0;
static mut CALLS: u32 = 0;
mod ffi {
    pub unsafe fn task_wake(id: u32) {
        super::LAST = id;
        super::CALLS += 1;
    }
}
mod waker;
#[cfg(kani)]
mod proofs {
    use super::*;
    #[kani::proof]
    fn opaque_waker_clone_drop_and_wake_preserve_every_u32_id() {
        let id: u32 = kani::any();
        let original = waker::new(id);
        let late = original.clone();
        drop(original);
        late.wake_by_ref();
        late.clone().wake();
        drop(late);
        unsafe {
            assert_eq!(LAST, id);
            assert_eq!(CALLS, 2);
        }
    }
}
