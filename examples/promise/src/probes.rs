//! Extended fixtures are compiled separately and excluded from size/timing artifacts.
use core::{
    cell::UnsafeCell,
    future::Future,
    pin::Pin,
    task::{Context, Poll, Waker},
};
use jsrt::{JsValue, future_to_promise};
#[link(wasm_import_module = "jsrt")]
unsafe extern "C" {
    fn probe_event(event: u32);
}
struct Saved(UnsafeCell<Option<Waker>>);
// This fixture is single-agent and all accesses end before any imported call.
unsafe impl Sync for Saved {}
static SAVED: Saved = Saved(UnsafeCell::new(None));
struct Probe {
    remaining: u32,
    save: bool,
}
impl Future for Probe {
    type Output = Result<JsValue, JsValue>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.save {
            unsafe {
                *SAVED.0.get() = Some(cx.waker().clone());
            }
            self.save = false;
        }
        unsafe {
            probe_event(0);
        }
        if self.remaining == 0 {
            Poll::Ready(Ok(JsValue::from_i32(42)))
        } else {
            self.remaining -= 1;
            cx.waker().wake_by_ref();
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        unsafe {
            probe_event(1);
        }
    }
}
#[unsafe(export_name = "self-wake")]
pub extern "C" fn self_wake(rounds: u32) -> u32 {
    if rounds & 0x4000_0000 != 0 {
        let bytes = core::hint::black_box([42u8; 512]);
        return future_to_promise(async move {
            core::hint::black_box(&bytes);
            Ok(JsValue::from_i32(bytes[0] as i32))
        })
        .into_abi();
    }
    // High bit suppresses saving, letting a new task coexist with an old Waker.
    future_to_promise(Probe {
        remaining: rounds & 0x7fff_ffff,
        save: rounds & 0x8000_0000 == 0,
    })
    .into_abi()
}
#[unsafe(no_mangle)]
pub extern "C" fn late_wake() {
    let waker = unsafe { (*SAVED.0.get()).clone() };
    if let Some(waker) = waker {
        waker.wake();
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn forget_waker() {
    unsafe {
        *SAVED.0.get() = None;
    }
}

extern crate alloc;
use jsrt::__private::{release, reserve, used};
#[unsafe(no_mangle)]
pub extern "C" fn mem_reserve(size: u32) -> u32 {
    unsafe { reserve(size, 8) }
}
fn exhaust() {
    let mut v = alloc::vec::Vec::<u8>::with_capacity(2 * 1024 * 1024);
    v.push(42);
    core::hint::black_box(v);
}
#[unsafe(no_mangle)]
pub extern "C" fn oom_sync() {
    exhaust();
}
#[unsafe(export_name = "oom-poll")]
pub extern "C" fn oom_poll() -> u32 {
    future_to_promise(async {
        exhaust();
        Ok(JsValue::undefined())
    })
    .into_abi()
}

// These imports and exports are absent from shipping artifacts.
#[unsafe(no_mangle)]
pub extern "C" fn storage_reserve(size: u32, align: u32) -> u32 {
    unsafe { reserve(size, align) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn storage_release(pointer: u32, _size: u32, _align: u32) {
    unsafe { release(pointer) }
}
#[unsafe(no_mangle)]
pub extern "C" fn storage_used() -> u32 {
    used()
}
#[unsafe(no_mangle)]
pub extern "C" fn storage_reserved() -> u32 {
    131072
}
