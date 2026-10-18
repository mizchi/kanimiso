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
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rt_settle(ptr: u32, result: u32, rejected: i32) {
    unsafe { jsrt::abi::settle(ptr, result, rejected) }
}
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
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn rt_poll(ptr: u32) -> i32 {
        unsafe { jsrt::abi::poll(ptr) }
    }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn rt_drop(ptr: u32) {
        unsafe { jsrt::abi::drop_task(ptr) }
    }
}
#[cfg(feature = "probes")]
mod probes;
