// Appended inside the copied production module to exercise its private completion.
#[cfg(kani)]
mod kani_proofs {
    use super::*;
    #[kani::proof]
    fn promise_result_ownership_through_pending_settle_consume_and_drop() {
        let stage: u8 = kani::any();
        kani::assume(stage <= 3);
        let id: u32 = kani::any();
        kani::assume(id != 0);
        let rejected: bool = kani::any();
        let undefined: bool = kani::any();
        unsafe {
            crate::ffi::PROMISE = true;
            crate::ffi::ID = id;
        }
        {
            let mut future = core::pin::pin!(unsafe { JsPromise::from_abi(1) }.into_future());
            let mut cx = Context::from_waker(Waker::noop());
            if stage >= 1 {
                assert!(future.as_mut().poll(&mut cx).is_pending());
                assert!(unsafe { crate::ffi::PROMISE && crate::ffi::WAIT });
            }
            if stage >= 2 {
                // The host retires a live subscription and transfers one result root.
                unsafe {
                    crate::ffi::WAIT = false;
                    crate::ffi::RESULT = !undefined;
                    future
                        .as_mut()
                        .get_unchecked_mut()
                        .complete(JsValue::from_abi(if undefined { 0 } else { 2 }), rejected);
                    assert!(!crate::ffi::PROMISE);
                }
            }
            if stage == 3 {
                let result = match future.as_mut().poll(&mut cx) {
                    Poll::Ready(result) => result,
                    _ => panic!("settled state must complete"),
                };
                assert_eq!(result.is_err(), rejected);
                drop(result);
            }
        }
        unsafe {
            assert!(!crate::ffi::PROMISE && !crate::ffi::RESULT && !crate::ffi::WAIT);
        }
    }
}
