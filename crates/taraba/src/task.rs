use crate::{JsPromise, JsValue, ffi};
use core::alloc::Layout;
use core::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

#[repr(C)]
struct Header {
    poll: unsafe fn(*mut Header) -> i32,
    drop: unsafe fn(*mut Header),
}
#[repr(C)]
struct Task<F> {
    header: Header,
    key: u32,
    future: F,
}
unsafe fn poll_task<F: Future<Output = Result<JsValue, JsValue>>>(pointer: *mut Header) -> i32 {
    let task = unsafe { &mut *pointer.cast::<Task<F>>() };
    let waker = crate::waker::new(task.key);
    let result =
        unsafe { Pin::new_unchecked(&mut task.future) }.poll(&mut Context::from_waker(&waker));
    if let Poll::Ready(result) = result {
        let (value, rejected) = match result {
            Ok(value) => (value, 0),
            Err(error) => (error, 1),
        };
        unsafe {
            ffi::task_finish(task.key, value.into_abi(), rejected);
        }
        1
    } else {
        0
    }
}
unsafe fn drop_task_type<F>(pointer: *mut Header) {
    unsafe {
        core::ptr::drop_in_place(pointer.cast::<Task<F>>());
        ffi::free(pointer as u32);
    }
}

/// Dropping this handle detaches the task. `cancel` drops its Future and subscriptions.
pub struct JoinHandle {
    key: u32,
    promise: JsPromise,
}
impl JoinHandle {
    pub fn cancel(&self) -> bool {
        unsafe { ffi::task_cancel(self.key) != 0 }
    }
    pub fn into_promise(self) -> JsPromise {
        self.promise
    }
}
fn spawn_inline<F>(future: F) -> JoinHandle
where
    F: Future<Output = Result<JsValue, JsValue>> + 'static,
{
    let key = unsafe { ffi::task_new() };
    let promise = unsafe { JsPromise::from_abi(ffi::task_promise(key)) };
    if key == 0 {
        drop(future);
        return JoinHandle { key, promise };
    }
    let layout = Layout::new::<Task<F>>();
    let pointer = unsafe {
        ffi::allocate(
            crate::storage::base() as u32,
            layout.size() as u32,
            layout.align() as u32,
        )
    } as *mut Task<F>;
    if pointer.is_null() {
        // The host never calls Rust while reserving a slot. Exhaustion is fatal.
        unsafe { ffi::oom(layout.size() as u32, layout.align() as u32) }
    }
    unsafe {
        pointer.write(Task {
            header: Header {
                poll: poll_task::<F>,
                drop: drop_task_type::<F>,
            },
            key,
            future,
        });
    }
    // Task address remains fixed through all polls. JS frees it only after poll returns.
    unsafe {
        ffi::task_start(key, pointer as u32);
    }
    JoinHandle { key, promise }
}
// The linked intrusive pool has 128-byte slots aligned to 64 bytes. This
// condition is constant per monomorphization: small Futures never link Box code.
const fn fits_inline<F>() -> bool {
    let layout = Layout::new::<Task<F>>();
    layout.size() <= 128 && layout.align() <= 64
}
fn spawn<F>(future: F) -> JoinHandle
where
    F: Future<Output = Result<JsValue, JsValue>> + 'static,
{
    if fits_inline::<F>() {
        spawn_inline(future)
    } else {
        // Pin before publishing the task address. Moving the pointer-sized
        // wrapper into the pool cannot move the !Unpin Future it owns.
        spawn_inline(alloc::boxed::Box::pin(future))
    }
}
pub fn spawn_local<F>(future: F) -> JoinHandle
where
    F: Future<Output = ()> + 'static,
{
    spawn(async move {
        future.await;
        Ok(JsValue::undefined())
    })
}
pub fn future_to_promise<F>(future: F) -> JsPromise
where
    F: Future<Output = Result<JsValue, JsValue>> + 'static,
{
    spawn(future).into_promise()
}
pub(crate) unsafe fn poll(pointer: u32) -> i32 {
    let header = pointer as *mut Header;
    unsafe { ((*header).poll)(header) }
}
pub(crate) unsafe fn drop_task(pointer: u32) {
    let header = pointer as *mut Header;
    unsafe {
        ((*header).drop)(header);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::boxed::Box;
    use core::marker::PhantomPinned;

    #[test]
    fn inline_policy_includes_the_header_and_alignment() {
        assert!(fits_inline::<core::future::Ready<Result<JsValue, JsValue>>>());
        assert!(!fits_inline::<[u8; 128]>());
        #[repr(align(128))]
        struct Aligned;
        assert!(!fits_inline::<Aligned>());
    }

    #[test]
    fn boxed_pinned_future_survives_moves_and_drops_once() {
        use core::cell::Cell;
        use core::task::Waker;
        struct Large<'a> {
            bytes: [u8; 256],
            address: Cell<usize>,
            drops: &'a Cell<u32>,
            _pin: PhantomPinned,
        }
        impl Future for Large<'_> {
            type Output = u8;
            fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<u8> {
                let address = self.as_ref().get_ref() as *const _ as usize;
                let previous = self.address.replace(address);
                if previous == 0 {
                    Poll::Pending
                } else {
                    assert_eq!(previous, address);
                    Poll::Ready(self.bytes[255])
                }
            }
        }
        impl Drop for Large<'_> {
            fn drop(&mut self) {
                self.drops.set(self.drops.get() + 1);
            }
        }
        let drops = Cell::new(0);
        let mut future = Box::pin(Large {
            bytes: [42; 256],
            address: Cell::new(0),
            drops: &drops,
            _pin: PhantomPinned,
        });
        assert!(fits_inline::<Pin<Box<Large<'_>>>>());
        let mut context = Context::from_waker(Waker::noop());
        assert_eq!(future.as_mut().poll(&mut context), Poll::Pending);
        let mut moved = future;
        assert_eq!(moved.as_mut().poll(&mut context), Poll::Ready(42));
        drop(moved);
        assert_eq!(drops.get(), 1);
    }
}
