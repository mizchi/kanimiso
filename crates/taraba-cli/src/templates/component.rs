#![cfg_attr(not(feature = "std"), no_std)]
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// WIT is the public contract. wit-bindgen owns the Canonical ABI and executor.
// Async annotations come from WIT; synchronous functions stay synchronous.
wit_bindgen::generate!({ path: "wit", world: "app" });

struct App;
impl Guest for App {
    async fn run(a: i32, b: i32) -> i32 {
        let first = add(a, b).await;
        add(first, 1).await
    }
}
export!(App);
