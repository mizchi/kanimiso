extern crate std;
use super::*;
use alloc::sync::Arc;
use core::{
    future::poll_fn,
    task::{Poll, Waker},
};
use std::sync::{Condvar, Mutex};

#[derive(Default)]
struct State {
    notified: bool,
    closed: bool,
    parks: usize,
    signals: usize,
}
#[derive(Clone, Default)]
struct TestSignal(Arc<(Mutex<State>, Condvar)>);
impl Signal for TestSignal {
    fn notify(&self) {
        let mut state = self.0.0.lock().unwrap();
        if !state.closed {
            state.signals += 1;
            state.notified = true;
            self.0.1.notify_one();
        }
    }
    fn park(&self) {
        let mut state = self.0.0.lock().unwrap();
        state.parks += 1;
        while !state.notified {
            let (next, timeout) = self
                .0
                .1
                .wait_timeout(state, std::time::Duration::from_secs(2))
                .unwrap();
            state = next;
            assert!(!timeout.timed_out() || state.notified, "lost wake");
        }
        state.notified = false;
    }
    fn close(&self) {
        self.0.0.lock().unwrap().closed = true;
    }
}

#[test]
fn ready_never_parks() {
    let s = TestSignal::default();
    assert_eq!(block_on(s.clone(), async { 42 }), 42);
    let state = s.0.0.lock().unwrap();
    assert_eq!(state.parks, 0);
    assert!(state.closed);
}
#[test]
fn wake_inside_poll_and_duplicate_wakes_are_not_lost() {
    let s = TestSignal::default();
    let mut polls = 0;
    let value = block_on(
        s.clone(),
        poll_fn(|cx| {
            polls += 1;
            if polls == 65 {
                return Poll::Ready(42);
            }
            cx.waker().wake_by_ref();
            cx.waker().clone().wake();
            Poll::Pending
        }),
    );
    assert_eq!(value, 42);
    assert_eq!(polls, 65);
    assert_eq!(s.0.0.lock().unwrap().parks, 64);
}
#[test]
fn external_wake_and_non_send_future_work() {
    let s = TestSignal::default();
    let slot = Arc::new(Mutex::new(None::<Waker>));
    let ready = Arc::new(core::sync::atomic::AtomicBool::new(false));
    let remote_slot = slot.clone();
    let remote_ready = ready.clone();
    let worker = std::thread::spawn(move || {
        let waker = loop {
            if let Some(w) = remote_slot.lock().unwrap().take() {
                break w;
            }
            std::thread::yield_now()
        };
        remote_ready.store(true, core::sync::atomic::Ordering::Release);
        waker.wake();
    });
    let local = alloc::rc::Rc::new(42);
    let value = block_on(
        s,
        poll_fn(|cx| {
            // Register before checking ready, so the test Future itself cannot lose a wake.
            *slot.lock().unwrap() = Some(cx.waker().clone());
            if ready.load(core::sync::atomic::Ordering::Acquire) {
                Poll::Ready(*local)
            } else {
                Poll::Pending
            }
        }),
    );
    worker.join().unwrap();
    assert_eq!(value, 42);
}
#[test]
fn escaped_waker_is_inert_after_completion() {
    let s = TestSignal::default();
    let mut escaped = None;
    block_on(
        s.clone(),
        poll_fn(|cx| {
            escaped = Some(cx.waker().clone());
            Poll::Ready(())
        }),
    );
    escaped.unwrap().wake();
    assert_eq!(s.0.0.lock().unwrap().signals, 0);
}

#[test]
fn completion_hook_delivers_a_child_waker_before_repoll() {
    use core::cell::Cell;
    let s = TestSignal::default();
    let delivered = Cell::new(false);
    let hook_calls = Cell::new(0);
    let mut polls = 0;
    let value = block_on_with(
        s,
        poll_fn(|cx| {
            polls += 1;
            if delivered.get() {
                return Poll::Ready(42);
            }
            cx.waker().wake_by_ref();
            Poll::Pending
        }),
        || {
            hook_calls.set(hook_calls.get() + 1);
            if hook_calls.get() == 2 {
                delivered.set(true)
            }
        },
    );
    assert_eq!(value, 42);
    assert_eq!(polls, 2);
}
#[test]
fn panic_unwinds_future_before_closing_signal() {
    struct Guard(TestSignal);
    impl Drop for Guard {
        fn drop(&mut self) {
            assert!(!self.0.0.0.lock().unwrap().closed)
        }
    }
    let s = TestSignal::default();
    let guard = Guard(s.clone());
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            block_on(s.clone(), async move {
                let _guard = guard;
                panic!("probe")
            });
        }))
        .is_err()
    );
    assert!(s.0.0.lock().unwrap().closed);
}
