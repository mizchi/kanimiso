use core::{
    ptr,
    task::{RawWaker, RawWakerVTable, Waker},
};
// No task pointer or reference count is stored here. IDs are never reused by a host.
// Callbacks touch no Rust allocation, including after the Future has been dropped.
// Production callbacks are only available in non-shared, single-agent wasm32.
static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, wake, wake, drop_id);
unsafe fn clone(data: *const ()) -> RawWaker {
    RawWaker::new(data, &VTABLE)
}
unsafe fn drop_id(_: *const ()) {}
unsafe fn wake(data: *const ()) {
    let id = data.addr() as u32;
    #[cfg(target_arch = "wasm32")]
    unsafe {
        crate::ffi::task_wake(id);
    }
    #[cfg(all(test, not(target_arch = "wasm32")))]
    EVENTS.lock().unwrap().push(id);
}
pub(crate) fn new(id: u32) -> Waker {
    // Token bits are opaque data, never dereferenced. Clone/drop require no resources.
    unsafe { Waker::from_raw(RawWaker::new(ptr::without_provenance(id as usize), &VTABLE)) }
}
#[cfg(all(test, not(target_arch = "wasm32")))]
static EVENTS: std::sync::Mutex<std::vec::Vec<u32>> = std::sync::Mutex::new(std::vec::Vec::new());
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    #[test]
    fn cloned_wakers_keep_only_the_opaque_id_and_can_be_dropped_or_sent() {
        let w = new(0xffff_fffe);
        let late = w.clone();
        drop(w);
        std::thread::spawn(move || {
            late.wake_by_ref();
            late.clone().wake();
        })
        .join()
        .unwrap();
        assert_eq!(*EVENTS.lock().unwrap(), [0xffff_fffe, 0xffff_fffe]);
        // A deliberately dangling numeric value is valid: no allocation is accessed.
        drop(new(1).clone());
    }
}
