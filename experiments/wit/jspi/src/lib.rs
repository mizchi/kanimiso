#![cfg_attr(not(feature = "std"), no_std)]
use core::{
    future::Future,
    task::{Context, Poll, Waker},
};
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
#[path = "../../shared/compute.rs"]
mod shared;
wit_bindgen::generate!({path:"wit",world:"app"});
struct App;
impl Guest for App {
    fn run(a: i32, b: i32) -> i32 {
        // Same async algorithm. JSPI suspends inside add; Rust's poll returns Ready.
        // This is deliberately NOT a block_on for arbitrary Pending Futures.
        let mut f = core::pin::pin!(shared::compute(a, b, |a, b| async move {
            Ok::<_, core::convert::Infallible>(add(a, b))
        }));
        match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(Ok(value)) => value,
            Poll::Ready(Err(never)) => match never {},
            Poll::Pending => core::arch::wasm32::unreachable(),
        }
    }
}
export!(App);
