#![cfg_attr(not(feature = "std"), no_std)]
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
#[cfg(not(feature = "probes"))]
wit_bindgen::generate!({path:"wit",world:"app"});
#[cfg(feature = "probes")]
wit_bindgen::generate!({path:"wit",world:"probes"});
struct App;
impl Guest for App {
    fn run(a: i32, b: i32) -> i32 {
        // Each synchronous-looking import can suspend on a native JS Promise.
        let first = add(a, b);
        add(first, 1)
    }
    #[cfg(feature = "probes")]
    fn hold(a: i32, b: i32) -> i32 {
        let bytes = core::hint::black_box([a as u8; 512]);
        let first = add(a, b);
        let after = core::hint::black_box(&bytes);
        for byte in after {
            if *byte != a as u8 {
                core::arch::wasm32::unreachable()
            }
        }
        first.wrapping_add(after[0] as i32)
    }
}
export!(App);
