use core::{
    future::Future,
    marker::PhantomData,
    pin::pin,
    ptr,
    task::{Context, Poll, RawWaker, RawWakerVTable, Waker},
};

/// All callbacks must be safe on any thread on which a Waker is used.
/// The JS implementation is single-agent. IDs must not be reused, and notify
/// after close must be ignored without accessing retired Rust state.
pub trait IdSignal: 'static {
    fn notify(id: u32);
    fn park(id: u32);
    fn close(id: u32);
}
struct IdWaker<S>(PhantomData<S>);
impl<S: IdSignal> IdWaker<S> {
    const VTABLE: RawWakerVTable =
        RawWakerVTable::new(Self::clone, Self::wake, Self::wake, Self::drop_id);
    fn raw(data: *const ()) -> RawWaker {
        // Keep the promoted vtable at one construction site for both new/clone.
        RawWaker::new(data, &Self::VTABLE)
    }
    unsafe fn clone(data: *const ()) -> RawWaker {
        Self::raw(data)
    }
    unsafe fn wake(data: *const ()) {
        S::notify(data.addr() as u32)
    }
    unsafe fn drop_id(_: *const ()) {}
}
/// Waker data is an opaque numeric ID; it is never dereferenced or freed.
/// No reference count, allocation or pointer to a stack-local signal is stored.
pub fn id_waker<S: IdSignal>(id: u32) -> Waker {
    // SAFETY: clone/drop do not access memory; wake calls a safe static function.
    // IDs can outlive the root. IdSignal must ignore retired IDs.
    unsafe { Waker::from_raw(IdWaker::<S>::raw(ptr::without_provenance(id as usize))) }
}
struct Owner<S: IdSignal>(u32, PhantomData<S>);
impl<S: IdSignal> Drop for Owner<S> {
    fn drop(&mut self) {
        S::close(self.0)
    }
}
pub fn block_on_id<S: IdSignal, F: Future>(
    id: u32,
    future: F,
    mut before_poll: impl FnMut(),
) -> F::Output {
    let _owner = Owner::<S>(id, PhantomData);
    let waker = id_waker::<S>(id);
    let mut cx = Context::from_waker(&waker);
    let mut future = pin!(future);
    loop {
        before_poll();
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(value) => return value,
            Poll::Pending => S::park(id),
        }
    }
}

/// Fixed registration storage, owned by one invocation's stack frame.
/// Returning removed/rejected Wakers lets the caller drop them after releasing
/// any RefCell borrow. IDs are job IDs, not reused slot indices.
pub struct Waiters<const N: usize> {
    entries: [Option<(i32, Waker)>; N],
}
impl<const N: usize> Default for Waiters<N> {
    fn default() -> Self {
        Self::new()
    }
}
impl<const N: usize> Waiters<N> {
    pub const fn new() -> Self {
        Self {
            entries: [const { None }; N],
        }
    }
    pub fn has_free(&self) -> bool {
        self.entries.iter().any(Option::is_none)
    }
    pub fn matches(&self, id: i32, waker: &Waker) -> bool {
        self.entries
            .iter()
            .flatten()
            .any(|(key, old)| *key == id && old.will_wake(waker))
    }
    pub fn insert(&mut self, id: i32, waker: Waker) -> Result<(), Waker> {
        if self.entries.iter().flatten().any(|(key, _)| *key == id) {
            return Err(waker);
        }
        if let Some(slot) = self.entries.iter_mut().find(|slot| slot.is_none()) {
            *slot = Some((id, waker));
            Ok(())
        } else {
            Err(waker)
        }
    }
    pub fn remove(&mut self, id: i32) -> Option<Waker> {
        self.entries
            .iter_mut()
            .find(|slot| slot.as_ref().is_some_and(|(key, _)| *key == id))
            .and_then(Option::take)
            .map(|(_, waker)| waker)
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;
    static mut LAST: u32 = 0;
    static mut CALLS: u32 = 0;
    struct Sink;
    impl IdSignal for Sink {
        fn notify(id: u32) {
            unsafe {
                LAST = id;
                CALLS += 1
            }
        }
        fn park(_: u32) {}
        fn close(_: u32) {}
    }
    #[kani::proof]
    fn id_waker_preserves_every_u32_without_owning_memory() {
        let id: u32 = kani::any();
        let first = id_waker::<Sink>(id);
        let late = first.clone();
        drop(first);
        late.wake_by_ref();
        late.clone().wake();
        drop(late);
        let last = unsafe { LAST };
        let calls = unsafe { CALLS };
        assert_eq!(last, id);
        assert_eq!(calls, 2);
    }
    #[kani::proof]
    #[kani::unwind(4)]
    fn fixed_slots_preserve_ids_at_capacity_and_after_reuse() {
        let a: i32 = kani::any();
        let b: i32 = kani::any();
        let c: i32 = kani::any();
        kani::assume(a != b && a != c && b != c);
        let mut slots = Waiters::<2>::new();
        assert!(slots.insert(a, id_waker::<Sink>(1)).is_ok());
        assert!(slots.insert(b, id_waker::<Sink>(2)).is_ok());
        assert!(!slots.has_free());
        assert!(slots.insert(c, id_waker::<Sink>(3)).is_err());
        assert_eq!(slots.remove(a).unwrap().data().addr(), 1);
        assert!(slots.has_free());
        assert!(slots.insert(c, id_waker::<Sink>(3)).is_ok());
        assert!(slots.remove(a).is_none());
        assert_eq!(slots.remove(b).unwrap().data().addr(), 2);
        assert_eq!(slots.remove(c).unwrap().data().addr(), 3);
    }
}
