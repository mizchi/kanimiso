use crate::{JsValue, ffi};
use core::{
    future::{Future, IntoFuture},
    marker::PhantomPinned,
    pin::Pin,
    task::{Context, Poll, Waker},
};

pub struct JsPromise(JsValue);
impl JsPromise {
    /// # Safety
    /// Transfers one Promise root from this host/instance. Host normalizes via Promise.resolve.
    pub unsafe fn from_abi(raw: u32) -> Self {
        Self(unsafe { JsValue::from_abi(raw) })
    }
    pub fn into_abi(self) -> u32 {
        self.0.into_abi()
    }
}
impl IntoFuture for JsPromise {
    type Output = Result<JsValue, JsValue>;
    type IntoFuture = JsFuture;
    fn into_future(self) -> Self::IntoFuture {
        JsFuture {
            value: self.0,
            wait: 0,
            rejected: None,
            waker: None,
            _pinned: PhantomPinned,
        }
    }
}

/// The host holds this state's pointer only while its non-reused subscription ID is live.
pub struct JsFuture {
    // Before completion this owns the Promise root; afterwards it owns its
    // result. A subscription keeps the JS Promise alive, so no second root is
    // needed once completion has transferred the result into this state.
    value: JsValue,
    wait: u32,
    rejected: Option<bool>,
    waker: Option<Waker>,
    _pinned: PhantomPinned,
}
impl Future for JsFuture {
    type Output = Result<JsValue, JsValue>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = unsafe { self.get_unchecked_mut() };
        if let Some(rejected) = this.rejected.take() {
            this.wait = 0;
            let value = core::mem::replace(&mut this.value, JsValue::undefined());
            return Poll::Ready(if rejected { Err(value) } else { Ok(value) });
        }
        this.waker = Some(cx.waker().clone());
        if this.wait == 0 {
            this.wait = unsafe { ffi::subscribe(this.value.raw(), this as *mut Self as u32) };
            if this.wait == 0 {
                return Poll::Ready(Err(unsafe { JsValue::from_abi(ffi::exhausted()) }));
            }
        }
        Poll::Pending
    }
}
impl Drop for JsFuture {
    fn drop(&mut self) {
        if self.wait != 0 {
            unsafe {
                ffi::unsubscribe(self.wait);
            }
        }
    }
}
impl JsFuture {
    fn complete(&mut self, value: JsValue, rejected: bool) {
        self.value = value;
        self.rejected = Some(rejected);
        if let Some(waker) = self.waker.take() {
            waker.wake();
        }
    }
}
pub(crate) unsafe fn settle(pointer: u32, value: u32, rejected: i32) {
    let this = unsafe { &mut *(pointer as *mut JsFuture) };
    let value = unsafe { JsValue::from_abi(value) };
    this.complete(value, rejected != 0);
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "promise_tests.rs"]
mod tests;
