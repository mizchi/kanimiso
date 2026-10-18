#![cfg_attr(not(feature = "std"), no_std)]
use core::{
    future::Future,
    task::{Context, Poll, Waker},
};
#[global_allocator]
static ALLOCATOR: kanimiso_allocator::Allocator = kanimiso_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
#[path = "../../shared/compute.rs"]
mod shared;
wit_bindgen::generate!({path:"wit",world:"app"});
use kanimiso::experiment::host::add;
struct App;
impl Guest for App {
    fn run(a: i32, b: i32) -> i32 {
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
