//! Raw allocator ABI for a trusted host: free/realloc require a live pointer and its exact layout.
#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;
mod kernel;
#[cfg(feature = "current")]
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(feature = "before")]
#[global_allocator]
static ALLOCATOR: before::Allocator = before::Allocator::INIT;
#[cfg(feature = "wee")]
#[global_allocator]
static ALLOCATOR: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;
#[unsafe(no_mangle)]
pub extern "C" fn bench_run(case: u32, rounds: u32, seed: u32, verify: u32) -> u32 {
    kernel::run(case, rounds, seed, verify != 0)
}
use core::alloc::Layout;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
#[unsafe(no_mangle)]
pub extern "C" fn mem_alloc(size: u32, align: u32) -> u32 {
    if size == 0 {
        return 0;
    }
    Layout::from_size_align(size as usize, align as usize)
        .ok()
        .map_or(0, |l| unsafe { alloc::alloc::alloc(l) as u32 })
}
#[unsafe(no_mangle)]
pub extern "C" fn mem_zeroed(size: u32, align: u32) -> u32 {
    if size == 0 {
        return 0;
    }
    Layout::from_size_align(size as usize, align as usize)
        .ok()
        .map_or(0, |l| unsafe { alloc::alloc::alloc_zeroed(l) as u32 })
}
/// # Safety
/// Pointer belongs to this allocator with the supplied nonzero layout.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mem_free(ptr: u32, size: u32, align: u32) {
    if ptr == 0 {
        return;
    }
    let l = Layout::from_size_align(size as usize, align as usize).unwrap();
    unsafe {
        alloc::alloc::dealloc(ptr as *mut u8, l);
    }
}
/// # Safety
/// Pointer/layout are live; success consumes the old pointer, failure preserves it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mem_realloc(ptr: u32, size: u32, align: u32, next: u32) -> u32 {
    if ptr == 0 || next == 0 {
        return 0;
    }
    let l = match Layout::from_size_align(size as usize, align as usize) {
        Ok(l) => l,
        Err(_) => return 0,
    };
    if Layout::from_size_align(next as usize, align as usize).is_err() {
        return 0;
    }
    unsafe { alloc::alloc::realloc(ptr as *mut u8, l, next as usize) as u32 }
}
