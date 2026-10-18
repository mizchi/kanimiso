extern crate std;
use super::*;
use core::task::{Context, Poll, Waker};
use std::sync::Mutex;

static EVENTS: Mutex<std::vec::Vec<u32>> = Mutex::new(std::vec::Vec::new());
struct Sink;
impl IdSignal for Sink {
    fn notify(id: u32) {
        EVENTS.lock().unwrap().push(id)
    }
    fn park(_: u32) {}
    fn close(_: u32) {}
}
#[test]
fn opaque_id_survives_clone_drop_and_cross_thread_wake() {
    let w = id_waker::<Sink>(0xffff_fffe);
    let late = w.clone();
    drop(w);
    std::thread::spawn(move || {
        late.wake_by_ref();
        late.clone().wake()
    })
    .join()
    .unwrap();
    assert_eq!(*EVENTS.lock().unwrap(), [0xffff_fffe, 0xffff_fffe]);
    drop(id_waker::<Sink>(1));
}
#[test]
fn fixed_slots_reject_overflow_reuse_removed_slot_and_ignore_unknown_ids() {
    let w = id_waker::<Sink>(7);
    let mut table = Waiters::<2>::new();
    assert!(table.insert(1, w.clone()).is_ok());
    assert!(table.insert(2, w.clone()).is_ok());
    assert!(!table.has_free());
    assert!(table.insert(3, w.clone()).is_err());
    assert!(table.remove(999).is_none());
    assert!(table.matches(1, &w));
    assert!(table.remove(1).is_some());
    assert!(table.has_free());
    assert!(table.insert(3, w).is_ok());
    assert!(table.remove(1).is_none());
    assert!(table.remove(3).is_some());
}
#[test]
fn zero_capacity_and_waker_replacement_are_explicit() {
    let a = id_waker::<Sink>(1);
    let b = id_waker::<Sink>(2);
    assert!(Waiters::<0>::new().insert(1, a.clone()).is_err());
    let mut table = Waiters::<1>::new();
    table.insert(4, a.clone()).unwrap();
    assert!(!table.matches(4, &b));
    drop(table.remove(4));
    table.insert(4, b.clone()).unwrap();
    assert!(table.matches(4, &b));
    assert!(!table.matches(4, &a));
}
#[test]
fn id_driver_runs_pending_future_with_pinned_local_state() {
    struct Noop;
    impl IdSignal for Noop {
        fn notify(_: u32) {}
        fn park(_: u32) {}
        fn close(_: u32) {}
    }
    let mut count = 0;
    let value = block_on_id::<Noop, _>(
        9,
        core::future::poll_fn(|cx| {
            count += 1;
            if count == 3 {
                return Poll::Ready(42);
            }
            cx.waker().wake_by_ref();
            Poll::Pending
        }),
        || {},
    );
    assert_eq!(value, 42);
}
#[test]
fn returned_or_panicking_future_drops_before_close_and_escaped_waker_is_safe() {
    static CLOSED: core::sync::atomic::AtomicBool = core::sync::atomic::AtomicBool::new(false);
    struct Closing;
    impl IdSignal for Closing {
        fn notify(_: u32) {}
        fn park(_: u32) {}
        fn close(_: u32) {
            CLOSED.store(true, core::sync::atomic::Ordering::SeqCst)
        }
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            assert!(!CLOSED.load(core::sync::atomic::Ordering::SeqCst))
        }
    }
    let mut escaped = None;
    block_on_id::<Closing, _>(
        1,
        async {
            let _guard = Guard;
            core::future::poll_fn(|cx| {
                escaped = Some(cx.waker().clone());
                Poll::Ready(())
            })
            .await
        },
        || {},
    );
    assert!(CLOSED.load(core::sync::atomic::Ordering::SeqCst));
    escaped.unwrap().wake();
    CLOSED.store(false, core::sync::atomic::Ordering::SeqCst);
    assert!(
        std::panic::catch_unwind(|| block_on_id::<Closing, _>(
            2,
            async {
                let _guard = Guard;
                panic!("probe")
            },
            || {}
        ))
        .is_err()
    );
    assert!(CLOSED.load(core::sync::atomic::Ordering::SeqCst));
}
#[test]
fn full_registry_drops_every_stored_waker() {
    use std::sync::Arc;
    struct Count;
    impl alloc::task::Wake for Count {
        fn wake(self: Arc<Self>) {}
    }
    let owner = Arc::new(Count);
    let w = Waker::from(owner.clone());
    {
        let mut slots = Waiters::<2>::new();
        slots.insert(1, w.clone()).unwrap();
        slots.insert(2, w.clone()).unwrap();
        assert_eq!(Arc::strong_count(&owner), 4);
    }
    assert_eq!(Arc::strong_count(&owner), 2);
    let _ = Context::from_waker(&w);
}
