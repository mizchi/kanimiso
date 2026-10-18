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
wit_bindgen::generate!({path:"wit", world:"app"});
::kanimiso::export_runtime!();
struct App;
impl Guest for App {
    fn run(a: i32, b: i32) -> Promise {
        let future = shared::compute(a, b, |a, b| async move {
            // Core profile owns a JS root, not a canonical resource-table handle.
            let p = unsafe { ::kanimiso::JsPromise::from_abi(add(a, b).take_handle()) };
            p.into_future()
                .await?
                .as_i32()
                .map_err(|e| ::kanimiso::JsValue::from_i32(e.0))
        });
        let p = ::kanimiso::future_to_promise(async move {
            future.await.map(::kanimiso::JsValue::from_i32)
        });
        unsafe { Promise::from_handle(p.into_abi()) }
    }
}
export!(App);
