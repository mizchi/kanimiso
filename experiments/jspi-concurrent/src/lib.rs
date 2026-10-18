#![cfg(target_arch = "wasm32")]
#![cfg_attr(not(feature = "std"), no_std)]
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
#[path = "../../wit/shared/compute.rs"]
mod shared;
#[cfg(not(feature = "probes"))]
wit_bindgen::generate!({path:"wit", world:"app"});
#[cfg(feature = "probes")]
wit_bindgen::generate!({path:"wit", world:"probes"});
struct App;
#[cfg(feature = "probes")]
fn held<const N: usize>(a: i32, b: i32) -> i32 {
    let bytes = core::hint::black_box([a as u8; N]);
    let first = add(a, b);
    let after = core::hint::black_box(&bytes);
    for byte in after {
        if *byte != a as u8 {
            core::arch::wasm32::unreachable()
        }
    }
    first.wrapping_add(after[0] as i32)
}
impl Guest for App {
    #[cfg(feature = "probes")]
    fn counter() -> i32 {
        use core::sync::atomic::{AtomicI32, Ordering};
        static COUNT: AtomicI32 = AtomicI32::new(0);
        COUNT.fetch_add(1, Ordering::Relaxed).wrapping_add(1)
    }
    fn run(a: i32, b: i32) -> i32 {
        use core::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        let mut f = core::pin::pin!(shared::compute(a, b, |a, b| async move {
            Ok::<_, core::convert::Infallible>(add(a, b))
        }));
        match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(Ok(value)) => value,
            _ => core::arch::wasm32::unreachable(),
        }
    }
    #[cfg(feature = "probes")]
    fn hold(a: i32, b: i32) -> i32 {
        held::<512>(a, b)
    }
    #[cfg(feature = "probes")]
    fn overwrite(a: i32, b: i32) -> i32 {
        held::<4096>(a, b)
    }
    #[cfg(feature = "probes")]
    fn grow(a: i32, b: i32) -> i32 {
        core::arch::wasm32::memory_grow::<0>(1);
        held::<512>(a, b)
    }
    #[cfg(feature = "probes")]
    fn borrowed(a: i32, b: i32) -> i32 {
        borrowed(a, b)
    }
    #[cfg(feature = "probes")]
    fn trap(a: i32, b: i32) -> i32 {
        let _ = held::<512>(a, b);
        core::arch::wasm32::unreachable()
    }
}
export!(App);

#[cfg(all(feature = "probes", feature = "std"))]
std::thread_local! { static SHARED: core::cell::RefCell<i32> = const { core::cell::RefCell::new(0) }; }
#[cfg(all(feature = "probes", feature = "std"))]
fn borrowed(a: i32, b: i32) -> i32 {
    SHARED.with(|shared| {
        let Ok(mut guard) = shared.try_borrow_mut() else {
            return -1;
        };
        *guard = a;
        let result = add(a, b);
        if *guard != a {
            core::arch::wasm32::unreachable()
        }
        result
    })
}
#[cfg(all(feature = "probes", not(feature = "std")))]
fn borrowed(a: i32, b: i32) -> i32 {
    use core::sync::atomic::{AtomicBool, Ordering};
    static HELD: AtomicBool = AtomicBool::new(false);
    if HELD.swap(true, Ordering::Relaxed) {
        return -1;
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            HELD.store(false, Ordering::Relaxed);
        }
    }
    let _guard = Guard;
    add(a, b)
}
