#![cfg_attr(not(feature = "std"), no_std)]
#[cfg(not(feature = "bounded"))]
extern crate alloc;
#[cfg(not(feature = "bounded"))]
use alloc::vec::Vec;
use core::{
    cell::RefCell,
    future::Future,
    pin::Pin,
    task::{Context, Poll, Waker},
};
#[cfg(feature = "bounded")]
use jspi_future_driver::{IdSignal, Waiters, block_on_id};
#[cfg(not(feature = "bounded"))]
use jspi_future_driver::{Signal, block_on_with};
#[cfg(all(feature = "arc", feature = "bounded"))]
compile_error!("bounded requires --no-default-features");
#[cfg(not(any(feature = "arc", feature = "bounded")))]
compile_error!("select arc or bounded");
#[cfg(any(not(feature = "bounded"), feature = "heap-probes"))]
#[global_allocator]
static ALLOCATOR: kanimiso_allocator::Allocator = kanimiso_allocator::Allocator::INIT;
#[cfg(all(feature = "bounded", not(feature = "heap-probes")))]
mod no_heap {
    use core::alloc::{GlobalAlloc, Layout};
    struct NoHeap;
    // SAFETY: never returns allocated storage. Unexpected alloc/free traps instead
    // of supplying a pointer or unwinding. This is a link-time sentinel, not a heap.
    unsafe impl GlobalAlloc for NoHeap {
        unsafe fn alloc(&self, _: Layout) -> *mut u8 {
            core::arch::wasm32::unreachable()
        }
        unsafe fn dealloc(&self, _: *mut u8, _: Layout) {
            core::arch::wasm32::unreachable()
        }
    }
    #[global_allocator]
    static ALLOCATOR: NoHeap = NoHeap;
}
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
#[cfg(not(feature = "probes"))]
wit_bindgen::generate!({path:"wit",world:"app"});
#[cfg(all(
    feature = "probes",
    any(not(feature = "bounded"), feature = "heap-probes")
))]
wit_bindgen::generate!({path:"wit",world:"probes"});
#[cfg(all(feature = "probes", feature = "bounded", not(feature = "heap-probes")))]
wit_bindgen::generate!({path:"wit",world:"bounded-probes"});
#[path = "../../wit/shared/compute.rs"]
mod shared;

#[cfg(not(feature = "bounded"))]
struct HostSignal(i32);
#[cfg(feature = "bounded")]
struct HostSignal;
#[cfg(not(feature = "bounded"))]
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
#[cfg(feature = "bounded")]
impl IdSignal for HostSignal {
    fn notify(id: u32) {
        signal(id as i32)
    }
    fn park(id: u32) {
        park(id as i32)
    }
    fn close(id: u32) {
        close(id as i32)
    }
}
fn drive<F: Future>(gate: i32, future: F, before_poll: impl FnMut()) -> F::Output {
    #[cfg(not(feature = "bounded"))]
    {
        block_on_with(HostSignal(gate), future, before_poll)
    }
    #[cfg(feature = "bounded")]
    {
        block_on_id::<HostSignal, _>(gate as u32, future, before_poll)
    }
}
#[cfg(feature = "bounded")]
const CAPACITY: usize = 16;
#[cfg(feature = "bounded")]
fn capacity_failure() -> ! {
    fail(1);
    core::arch::wasm32::unreachable()
}
#[cfg(feature = "bounded")]
fn borrow_failure() -> ! {
    fail(2);
    core::arch::wasm32::unreachable()
}
// Single-root, single-agent I/O registration. JS never invokes a Rust callback.
// Actual child Wakers are called only after JSPI resumes the Rust stack.
struct Bridge {
    gate: i32,
    #[cfg(not(feature = "bounded"))]
    waiters: RefCell<Vec<(i32, Waker)>>,
    #[cfg(feature = "bounded")]
    waiters: RefCell<Waiters<CAPACITY>>,
}
impl Bridge {
    fn new() -> Self {
        Self {
            gate: open(),
            #[cfg(not(feature = "bounded"))]
            waiters: RefCell::new(Vec::new()),
            #[cfg(feature = "bounded")]
            waiters: RefCell::new(Waiters::new()),
        }
    }
    fn run<F: Future>(&self, future: F) -> F::Output {
        drive(self.gate, future, || {
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
    #[cfg(not(feature = "bounded"))]
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
    #[cfg(not(feature = "bounded"))]
    fn remove(&self, id: i32) -> Option<Waker> {
        let mut waiters = self.waiters.borrow_mut();
        if let Some(index) = waiters.iter().position(|(job, _)| *job == id) {
            return Some(waiters.swap_remove(index).1);
        }
        None
    }
    #[cfg(feature = "bounded")]
    fn register(&self, id: i32, waker: &Waker) {
        if self.fixed_waiters().matches(id, waker) {
            return;
        }
        let new = waker.clone();
        let old = self.remove(id);
        let result = self.fixed_waiters_mut().insert(id, new);
        drop(old);
        if let Err(waker) = result {
            drop(waker);
            capacity_failure()
        }
    }
    #[cfg(feature = "bounded")]
    fn remove(&self, id: i32) -> Option<Waker> {
        self.fixed_waiters_mut().remove(id)
    }
    #[cfg(feature = "bounded")]
    fn require_slot(&self) {
        if !self.fixed_waiters().has_free() {
            capacity_failure()
        }
    }
    #[cfg(feature = "bounded")]
    fn fixed_waiters(&self) -> core::cell::Ref<'_, Waiters<CAPACITY>> {
        self.waiters
            .try_borrow()
            .unwrap_or_else(|_| borrow_failure())
    }
    #[cfg(feature = "bounded")]
    fn fixed_waiters_mut(&self) -> core::cell::RefMut<'_, Waiters<CAPACITY>> {
        self.waiters
            .try_borrow_mut()
            .unwrap_or_else(|_| borrow_failure())
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
                #[cfg(feature = "bounded")]
                self.bridge.require_slot();
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
#[cfg(feature = "probes")]
fn capacity_jobs(count: i32, drop_all: bool) -> i32 {
    let bridge = Bridge::new();
    bridge.run(async {
        let mut jobs: [Option<Add<'_>>; 17] =
            core::array::from_fn(|i| Some(Add::new(&bridge, i as i32, 1)));
        let mut total = 0;
        core::future::poll_fn(|cx| {
            let mut pending = false;
            for slot in jobs.iter_mut().take(count.clamp(0, 17) as usize) {
                if let Some(job) = slot {
                    match Pin::new(job).poll(cx) {
                        Poll::Ready(Ok(value)) => {
                            total += value;
                            *slot = None;
                        }
                        Poll::Pending => pending = true,
                    }
                }
            }
            if drop_all || !pending {
                Poll::Ready(total)
            } else {
                Poll::Pending
            }
        })
        .await
    })
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
        drive(
            gate,
            core::future::poll_fn(|cx| {
                if left == 0 {
                    return Poll::Ready(count);
                }
                left -= 1;
                cx.waker().wake_by_ref();
                cx.waker().clone().wake();
                Poll::Pending
            }),
            || {},
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
    #[cfg(all(
        feature = "probes",
        any(not(feature = "bounded"), feature = "heap-probes")
    ))]
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
    fn capacity(count: i32) -> i32 {
        capacity_jobs(count, false)
    }
    #[cfg(feature = "probes")]
    fn drop_capacity(count: i32) -> i32 {
        capacity_jobs(count, true)
    }
    #[cfg(feature = "probes")]
    fn borrow_conflict() {
        let bridge = Bridge::new();
        let guard = bridge.waiters.borrow_mut();
        let _ = bridge.run(Add::new(&bridge, 1, 2));
        drop(guard);
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
