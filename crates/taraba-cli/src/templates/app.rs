#![cfg_attr(not(feature = "std"), no_std)]
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
async fn compute(a: i32, b: i32) -> Result<::taraba::JsValue, ::taraba::JsValue> {
    async fn call(a: i32, b: i32) -> Result<i32, ::taraba::JsValue> {
        // Core profile: ownership is a JS root. This is not a canonical resource table.
        let p = unsafe { ::taraba::JsPromise::from_abi(add(a, b).take_handle()) };
        p.into_future()
            .await?
            .as_i32()
            .map_err(|e| ::taraba::JsValue::from_i32(e.0))
    }
    let first = call(a, b).await?;
    call(first, 1).await.map(::taraba::JsValue::from_i32)
}
wit_bindgen::generate!({path:"wit", world:"app"});
::taraba::export_runtime!();
struct App;
impl Guest for App {
    fn run(a: i32, b: i32) -> Promise {
        let p = ::taraba::future_to_promise(compute(a, b));
        unsafe { Promise::from_handle(p.into_abi()) }
    }
}
export!(App);
