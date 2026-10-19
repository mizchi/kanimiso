#![cfg_attr(not(feature = "std"), no_std)]
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
mod workflow;

#[cfg(feature = "test-api")]
#[unsafe(no_mangle)]
pub extern "C" fn add(a: i32, b: i32) -> i32 {
    a.wrapping_add(b)
}
jsrt::export_runtime!();
mod custom {
    use jsrt::future_to_promise;
    #[cfg(feature = "test-api")]
    use jsrt::{JsPromise, spawn_local};
    #[unsafe(no_mangle)]
    pub extern "C" fn start(a: i32, b: i32) -> u32 {
        future_to_promise(super::workflow::compute(a, b)).into_abi()
    }
    #[cfg(feature = "test-api")]
    #[unsafe(export_name = "await-value")]
    pub unsafe extern "C" fn await_value(p: u32) -> u32 {
        future_to_promise(super::workflow::forward(unsafe { JsPromise::from_abi(p) })).into_abi()
    }
    #[cfg(feature = "test-api")]
    #[unsafe(export_name = "spawn-empty")]
    pub extern "C" fn spawn_empty() -> u32 {
        spawn_local(async {}).into_promise().into_abi()
    }
}
#[cfg(feature = "probes")]
mod probes;
