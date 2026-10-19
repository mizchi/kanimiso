//! Opt-in panic reporting for the taraba Core JS host (JSPI or Future).
//!
//! Release sends only PN01; debug assertions or `panic-details` include Rust
//! panic text, which the JS host decodes only when built with `--debug`.
//! Reporting closes the instance; it does not unwind Rust or run destructors.
//! std may format a dynamic payload before invoking the hook. Only the no_std
//! release handler bypasses that infrastructure entirely.

#[link(wasm_import_module = "taraba:panic")]
unsafe extern "C" {
    // Borrows a UTF-8 slice synchronously; the matching host always throws.
    #[link_name = "report"]
    fn report_import(pointer: *const u8, length: usize) -> !;
}

fn report(info: &impl core::fmt::Display) -> ! {
    #[cfg(any(debug_assertions, feature = "panic-details"))]
    {
        let message = alloc::format!("{info}");
        // SAFETY: the string stays live through this synchronous host call.
        // The host reads it before poisoning the instance and throwing.
        unsafe { report_import(message.as_ptr(), message.len()) }
    }
    #[cfg(not(any(debug_assertions, feature = "panic-details")))]
    {
        let _ = info;
        // SAFETY: zero length carries no borrowed memory. The host throws PN01.
        unsafe { report_import(core::ptr::null(), 0) }
    }
}

/// Call from the embedding no_std application's `#[panic_handler]`.
/// The application owns the handler; this library does not define a global one.
pub fn handler(info: &core::panic::PanicInfo<'_>) -> ! {
    report(info)
}

/// Install once before entering code that can panic. Requires `std`.
///
/// Replaces the previous hook on the first call. Later calls leave subsequent
/// application hooks alone. Unlike console_error_panic_hook, release does not
/// format the hook information or move a JS stack string into Wasm memory.
/// std can still format a dynamic panic payload before invoking this hook.
/// `std`'s panic infrastructure can remain linked; this is not a panic snipper.
#[cfg(feature = "std")]
pub fn set_hook() {
    use core::sync::atomic::{AtomicBool, Ordering};
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    // The crate supports one JS agent, without shared memory or concurrent entry.
    if !INSTALLED.swap(true, Ordering::Relaxed) {
        std::panic::set_hook(alloc::boxed::Box::new(|info| report(info)));
    }
}
