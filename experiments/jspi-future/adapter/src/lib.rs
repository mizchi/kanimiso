#![no_std]
#[cfg(any(feature = "alloc", test))]
extern crate alloc;

#[cfg(feature = "bounded")]
mod bounded;
#[cfg(feature = "bounded")]
pub use bounded::*;

#[cfg(feature = "alloc")]
mod arc_driver {
    use alloc::{sync::Arc, task::Wake};
    use core::{
        future::Future,
        pin::pin,
        sync::atomic::{AtomicBool, Ordering},
        task::{Context, Poll, Waker},
    };

    /// A latched notification: notify before park must make the next park return.
    /// park may suspend via JSPI, but is only called AFTER Future::poll returns.
    /// Implementations must allow late notify after close and ignore it safely.
    pub trait Signal: Send + Sync + 'static {
        fn notify(&self);
        fn park(&self);
        fn close(&self);
    }

    struct Notification<S: Signal> {
        signal: S,
        closed: AtomicBool,
    }
    impl<S: Signal> Wake for Notification<S> {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            if !self.closed.load(Ordering::Acquire) {
                self.signal.notify();
            }
        }
    }
    struct Owner<S: Signal>(Arc<Notification<S>>);
    impl<S: Signal> Drop for Owner<S> {
        fn drop(&mut self) {
            self.0.closed.store(true, Ordering::Release);
            self.0.signal.close();
        }
    }
    /// Experimental single-root driver. No spawn, cancellation or runtime services.
    /// The Future lives on the caller's pinned stack; only the safe Arc Waker allocates.
    /// This does not make other runtimes' I/O, timers or task handles compatible.
    pub fn block_on<S: Signal, F: Future>(signal: S, future: F) -> F::Output {
        block_on_with(signal, future, || {})
    }
    /// Deliver host completions on the resumed Rust stack before polling the root.
    /// The hook may wake child Wakers (e.g. FuturesUnordered), never reenter a poll.
    pub fn block_on_with<S: Signal, F: Future>(
        signal: S,
        future: F,
        mut before_poll: impl FnMut(),
    ) -> F::Output {
        let owner = Owner(Arc::new(Notification {
            signal,
            closed: AtomicBool::new(false),
        }));
        let waker = Waker::from(owner.0.clone());
        let mut context = Context::from_waker(&waker);
        // Declared after owner: Future::drop runs before the notification is closed.
        let mut future = pin!(future);
        loop {
            before_poll();
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => owner.0.signal.park(),
            }
        }
    }
}
#[cfg(feature = "alloc")]
pub use arc_driver::*;

#[cfg(all(test, feature = "alloc"))]
mod tests;

#[cfg(all(test, feature = "bounded"))]
mod bounded_tests;
