#![cfg_attr(not(feature = "std"), no_std)]
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
wit_bindgen::generate!({path:"wit",world:"app"});
struct App;
impl Guest for App {
    fn run(a: i32, b: i32) -> i32 {
        // Each synchronous-looking import can suspend on a native JS Promise.
        let first = add(a, b);
        add(first, 1)
    }
}
export!(App);
