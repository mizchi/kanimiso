#![cfg_attr(not(feature = "std"), no_std)]
#[global_allocator]
static ALLOCATOR: kanimiso_allocator::Allocator = kanimiso_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
#[path = "../../shared/compute.rs"]
mod shared;
wit_bindgen::generate!({path:"wit",world:"app",async:true});
struct App;
impl Guest for App {
    async fn run(a: i32, b: i32) -> i32 {
        match shared::compute(a, b, |a, b| async move {
            Ok::<_, core::convert::Infallible>(add(a, b).await)
        })
        .await
        {
            Ok(value) => value,
            Err(never) => match never {},
        }
    }
}
export!(App);
