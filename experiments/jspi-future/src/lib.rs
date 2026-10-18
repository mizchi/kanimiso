#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;
use alloc::vec::Vec;
use core::{
    cell::RefCell,
    future::Future,
    pin::Pin,
    task::{Context, Poll, Waker},
};
use jspi_future_driver::{Signal, block_on, block_on_with};
#[global_allocator]
static ALLOCATOR: kanimiso_allocator::Allocator = kanimiso_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
#[cfg(not(feature = "probes"))]
wit_bindgen::generate!({path:"wit",world:"app"});
#[cfg(feature = "probes")]
wit_bindgen::generate!({path:"wit",world:"probes"});
#[path = "../../wit/shared/compute.rs"]
mod shared;

struct HostSignal(i32);
impl Signal for HostSignal {
    fn notify(&self) {
        signal(self.0);
    }
    fn park(&self) {
        park(self.0);
    }
    fn close(&self) {
        close(self.0);
    }
}
// Single-root, single-agent I/O registration. JS never invokes a Rust callback.
// Actual child Wakers are called only after JSPI resumes the Rust stack.
struct Bridge {
    gate: i32,
    waiters: RefCell<Vec<(i32, Waker)>>,
}
impl Bridge {
    fn new() -> Self {
        Self {
            gate: open(),
            waiters: RefCell::new(Vec::new()),
        }
    }
    fn run<F: Future>(&self, future: F) -> F::Output {
        block_on_with(HostSignal(self.gate), future, || {
            loop {
                let id = drain(self.gate);
                if id == 0 {
                    break;
                }
                let waker = self.remove(id);
                // Release RefCell borrow before any user Waker executes.
                if let Some(waker) = waker {
                    waker.wake()
                }
            }
        })
    }
    fn register(&self, id: i32, waker: &Waker) {
        let changed = self
            .waiters
            .borrow()
            .iter()
            .find(|(job, _)| *job == id)
            .is_none_or(|(_, old)| !old.will_wake(waker));
        if !changed {
            return;
        }
        let new = waker.clone();
        let old = self.remove(id);
        self.waiters.borrow_mut().push((id, new));
        drop(old);
    }
    fn remove(&self, id: i32) -> Option<Waker> {
        let mut waiters = self.waiters.borrow_mut();
        if let Some(index) = waiters.iter().position(|(job, _)| *job == id) {
            return Some(waiters.swap_remove(index).1);
        }
        None
    }
    fn unregister(&self, id: i32) {
        drop(self.remove(id))
    }
}
struct Add<'a> {
    bridge: &'a Bridge,
    args: (i32, i32),
    job: Option<i32>,
}
impl<'a> Add<'a> {
    fn new(bridge: &'a Bridge, a: i32, b: i32) -> Self {
        Self {
            bridge,
            args: (a, b),
            job: None,
        }
    }
}
impl Future for Add<'_> {
    type Output = Result<i32, core::convert::Infallible>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let job = match self.job {
            Some(job) => job,
            None => {
                let job = begin(self.bridge.gate, self.args.0, self.args.1);
                self.job = Some(job);
                job
            }
        };
        self.bridge.register(job, cx.waker());
        if ready(job) == 0 {
            return Poll::Pending;
        }
        self.job = None;
        self.bridge.unregister(job);
        Poll::Ready(Ok(take(job)))
    }
}
impl Drop for Add<'_> {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            self.bridge.unregister(job);
            cancel(job)
        }
    }
}
struct App;
impl Guest for App {
    fn run(a: i32, b: i32) -> i32 {
        let bridge = Bridge::new();
        bridge
            .run(shared::compute(a, b, |a, b| Add::new(&bridge, a, b)))
            .unwrap()
    }
    #[cfg(feature = "probes")]
    fn self_wake(count: i32) -> i32 {
        let gate = open();
        let mut left = count.max(0);
        block_on(
            HostSignal(gate),
            core::future::poll_fn(|cx| {
                if left == 0 {
                    return Poll::Ready(count);
                }
                left -= 1;
                cx.waker().wake_by_ref();
                cx.waker().clone().wake();
                Poll::Pending
            }),
        )
    }
    #[cfg(feature = "probes")]
    fn joined(a: i32, b: i32) -> i32 {
        let bridge = Bridge::new();
        let (first, second) = bridge.run(futures_util::future::join(
            Add::new(&bridge, a, 1),
            Add::new(&bridge, b, 2),
        ));
        first.unwrap().wrapping_add(second.unwrap())
    }
    #[cfg(feature = "probes")]
    fn unordered(a: i32, b: i32) -> i32 {
        use futures_util::{StreamExt, stream::FuturesUnordered};
        let bridge = Bridge::new();
        let mut jobs = FuturesUnordered::new();
        jobs.push(Add::new(&bridge, a, 1));
        jobs.push(Add::new(&bridge, b, 2));
        bridge.run(async {
            let first = jobs.next().await.unwrap().unwrap();
            let second = jobs.next().await.unwrap().unwrap();
            first.wrapping_add(second)
        })
    }
    #[cfg(feature = "probes")]
    fn raced(a: i32, b: i32) -> i32 {
        use futures_util::future::{Either, select};
        let bridge = Bridge::new();
        bridge.run(async {
            let first = core::pin::pin!(Add::new(&bridge, a, 1));
            let second = core::pin::pin!(Add::new(&bridge, b, 2));
            match select(first, second).await {
                Either::Left((value, _)) | Either::Right((value, _)) => value.unwrap(),
            }
        })
    }
    #[cfg(feature = "probes")]
    fn held(a: i32, b: i32) -> i32 {
        struct Guard;
        impl Drop for Guard {
            fn drop(&mut self) {
                dropped()
            }
        }
        let bridge = Bridge::new();
        bridge.run(async {
            let _guard = Guard;
            let bytes = core::hint::black_box([a as u8; 1024]);
            let first = Add::new(&bridge, a, b).await.unwrap();
            let after = core::hint::black_box(&bytes);
            for byte in after {
                if *byte != a as u8 {
                    core::arch::wasm32::unreachable()
                }
            }
            first.wrapping_add(after[0] as i32)
        })
    }
    #[cfg(feature = "probes")]
    fn trap() {
        let bridge = Bridge::new();
        bridge.run(async {
            let _ = Add::new(&bridge, 1, 2).await;
            core::arch::wasm32::unreachable();
        })
    }
}
export!(App);
