//! Native ownership checks using the production Future and a recording FFI host.
//! Pointers passed to subscribe are opaque here; Wasm/JS tests cover their use.
use super::*;
use std::{
    cell::{Cell, RefCell},
    sync::Arc,
    task::Wake,
    vec::Vec,
};

#[derive(Debug, PartialEq)]
enum Event {
    Release(u32),
    Subscribe(u32),
    Unsubscribe(u32),
    Wake(u32),
}
std::thread_local! {
    static EVENTS: RefCell<Vec<Event>> = const { RefCell::new(Vec::new()) };
    static WAIT_ID: Cell<u32> = const { Cell::new(1) };
}
fn record(event: Event) {
    EVENTS.with_borrow_mut(|events| events.push(event));
}
fn events() -> Vec<Event> {
    EVENTS.with_borrow_mut(core::mem::take)
}
// Resolve only the FFI symbols exercised by JsFuture. These mocks are excluded
// from shipping builds and never dereference a truncated native pointer.
#[unsafe(no_mangle)]
extern "C" fn release(value: u32) {
    if value != 0 {
        record(Event::Release(value));
    }
}
#[unsafe(no_mangle)]
extern "C" fn subscribe(promise: u32, _: u32) -> u32 {
    record(Event::Subscribe(promise));
    WAIT_ID.with(Cell::get)
}
#[unsafe(no_mangle)]
extern "C" fn unsubscribe(wait: u32) {
    record(Event::Unsubscribe(wait));
}
#[unsafe(no_mangle)]
extern "C" fn exhausted() -> u32 {
    99
}
struct Notice(u32);
impl Wake for Notice {
    fn wake(self: Arc<Self>) {
        record(Event::Wake(self.0));
    }
}
fn future() -> Pin<std::boxed::Box<JsFuture>> {
    std::boxed::Box::pin(unsafe { JsPromise::from_abi(10) }.into_future())
}
fn poll(future: Pin<&mut JsFuture>, waker: &Waker) -> Poll<Result<JsValue, JsValue>> {
    future.poll(&mut Context::from_waker(waker))
}
fn complete(mut future: Pin<&mut JsFuture>, value: u32, rejected: bool) {
    // Keep the subscription state pinned; complete only replaces owned fields.
    unsafe {
        future
            .as_mut()
            .get_unchecked_mut()
            .complete(JsValue::from_abi(value), rejected);
    }
}

#[test]
fn completion_reuses_the_promise_root_and_wakes_the_latest_external_waker() {
    let a = Arc::new(Notice(1));
    let b = Arc::new(Notice(2));
    let wa = Waker::from(a.clone());
    let wb = Waker::from(b.clone());
    let mut f = future();
    assert!(poll(f.as_mut(), &wa).is_pending());
    assert_eq!(events(), [Event::Subscribe(10)]);
    assert_eq!(Arc::strong_count(&a), 3);
    assert!(poll(f.as_mut(), &wb).is_pending());
    assert_eq!(Arc::strong_count(&a), 2);
    assert_eq!(Arc::strong_count(&b), 3);
    complete(f.as_mut(), 20, false);
    assert_eq!(events(), [Event::Release(10), Event::Wake(2)]);
    assert_eq!(Arc::strong_count(&b), 2);
    let value = match poll(f.as_mut(), &wb) {
        Poll::Ready(Ok(value)) => value,
        _ => panic!("completion must transfer the result"),
    };
    assert_eq!(value.raw(), 20);
    drop(f);
    assert!(
        events().is_empty(),
        "the returned root belongs to the caller"
    );
    drop(value);
    assert_eq!(events(), [Event::Release(20)]);
}

#[test]
fn cancellation_releases_exactly_the_current_value_and_subscription() {
    let waker = Waker::from(Arc::new(Notice(1)));
    for settled in [false, true] {
        let mut f = future();
        assert!(poll(f.as_mut(), &waker).is_pending());
        assert_eq!(events(), [Event::Subscribe(10)]);
        if settled {
            complete(f.as_mut(), 20, true);
            assert_eq!(events(), [Event::Release(10), Event::Wake(1)]);
        }
        drop(f);
        assert_eq!(
            events(),
            [
                Event::Unsubscribe(1),
                Event::Release(if settled { 20 } else { 10 })
            ]
        );
    }
    drop(future());
    assert_eq!(events(), [Event::Release(10)]);
}

#[test]
fn undefined_completion_and_rejection_are_distinct_from_pending() {
    for rejected in [false, true] {
        let waker = Waker::from(Arc::new(Notice(1)));
        let mut f = future();
        assert!(poll(f.as_mut(), &waker).is_pending());
        events();
        complete(f.as_mut(), 0, rejected);
        assert_eq!(events(), [Event::Release(10), Event::Wake(1)]);
        let result = match poll(f.as_mut(), &waker) {
            Poll::Ready(value) => value,
            _ => panic!("undefined must complete"),
        };
        assert_eq!(result.is_err(), rejected);
        drop(result);
        drop(f);
        assert!(events().is_empty());
    }
}

#[test]
fn subscription_exhaustion_returns_an_owned_error_and_drops_the_promise() {
    WAIT_ID.with(|id| id.set(0));
    let mut f = future();
    let result = match poll(f.as_mut(), Waker::noop()) {
        Poll::Ready(Err(value)) => value,
        _ => panic!("exhaustion must reject without retaining a wait"),
    };
    WAIT_ID.with(|id| id.set(1));
    assert_eq!(result.raw(), 99);
    assert_eq!(events(), [Event::Subscribe(10)]);
    drop(result);
    drop(f);
    assert_eq!(events(), [Event::Release(99), Event::Release(10)]);
}
