#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;
#[cfg(all(feature = "core-runtime", feature = "component"))]
compile_error!("select one backend");
#[cfg(not(feature = "measured"))]
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(feature = "measured")]
mod measured;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
#[cfg(feature = "core-runtime")]
include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
#[cfg(feature = "core-runtime")]
bindings!();
#[cfg(all(feature = "component", not(feature = "measured")))]
wit_bindgen::generate!({path:"wit",world:"app"});
#[cfg(all(feature = "component", feature = "measured"))]
wit_bindgen::generate!({path:"wit",world:"measured"});
mod workflow;
struct App;
#[cfg(feature = "core-runtime")]
impl Guest for App {
    fn process(
        value: Packet,
    ) -> impl core::future::Future<Output = HostResult<Result<Packet, alloc::string::String>>> {
        workflow::process(value, transform)
    }
    #[cfg(feature = "measured")]
    fn heap_live() -> u32 {
        measured::live()
    }
    #[cfg(feature = "measured")]
    fn heap_peak() -> u32 {
        measured::peak()
    }
    #[cfg(feature = "measured")]
    fn heap_reset() {
        measured::reset()
    }
    #[cfg(feature = "measured")]
    fn linear_bytes() -> u32 {
        (core::arch::wasm32::memory_size::<0>() * 65536) as u32
    }
}
#[cfg(feature = "component")]
impl Guest for App {
    async fn process(value: Packet) -> Result<Packet, alloc::string::String> {
        workflow::process(value, |v| async move {
            Ok::<_, core::convert::Infallible>(transform(v).await)
        })
        .await
        .unwrap()
    }
    #[cfg(feature = "measured")]
    fn heap_live() -> u32 {
        measured::live()
    }
    #[cfg(feature = "measured")]
    fn heap_peak() -> u32 {
        measured::peak()
    }
    #[cfg(feature = "measured")]
    fn heap_reset() {
        measured::reset()
    }
    #[cfg(feature = "measured")]
    fn linear_bytes() -> u32 {
        (core::arch::wasm32::memory_size::<0>() * 65536) as u32
    }
}
export!(App);
