#![cfg_attr(not(feature = "std"), no_std)]
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
bindings!();
struct App;
impl Guest for App {
    async fn run(a: i32, b: i32) -> HostResult<i32> {
        let first = add(a, b).await?;
        add(first, 1).await
    }
}
export!(App);
