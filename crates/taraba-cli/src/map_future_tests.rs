mod tests {
    use super::*;
    use core::{
        cell::Cell,
        future::Future,
        marker::PhantomPinned,
        pin::{Pin, pin},
        task::{Context, Poll, Waker},
    };
    struct AddressSensitive<'a> {
        address: *const (),
        pending: bool,
        drops: &'a Cell<u32>,
        _pinned: PhantomPinned,
    }
    impl Future for AddressSensitive<'_> {
        type Output = i32;
        fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<i32> {
            let address = (self.as_ref().get_ref() as *const Self).cast();
            // The test changes scalar state without moving its pinned value.
            let this = unsafe { self.get_unchecked_mut() };
            if this.address.is_null() {
                this.address = address;
            }
            assert_eq!(this.address, address);
            if this.pending {
                this.pending = false;
                Poll::Pending
            } else {
                Poll::Ready(21)
            }
        }
    }
    impl Drop for AddressSensitive<'_> {
        fn drop(&mut self) {
            if !self.address.is_null() {
                assert_eq!(self.address, (self as *const Self).cast());
            }
            self.drops.set(self.drops.get() + 1);
        }
    }
    #[test]
    fn pin_address_and_drop_survive_pending_ready_and_cancellation() {
        for cancel in [false, true] {
            let drops = Cell::new(0);
            let mapped = Cell::new(0);
            {
                let mut future = pin!(map_future(
                    AddressSensitive {
                        address: core::ptr::null(),
                        pending: true,
                        drops: &drops,
                        _pinned: PhantomPinned,
                    },
                    |value| {
                        mapped.set(mapped.get() + 1);
                        value * 2
                    }
                ));
                let mut cx = Context::from_waker(Waker::noop());
                assert_eq!(future.as_mut().poll(&mut cx), Poll::Pending);
                assert_eq!(mapped.get(), 0);
                if !cancel {
                    assert_eq!(future.as_mut().poll(&mut cx), Poll::Ready(42));
                    assert_eq!(mapped.get(), 1);
                }
            }
            assert_eq!(drops.get(), 1);
            assert_eq!(mapped.get(), u32::from(!cancel));
        }
    }
    #[test]
    fn rejected_result_keeps_its_identity() {
        let error = Cell::new(0);
        let mut future = pin!(map_future(
            core::future::ready(Err::<i32, _>(&error)),
            |result| result.map(|value| value * 2)
        ));
        let Poll::Ready(Err(actual)) = future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        else {
            panic!("expected the original rejection")
        };
        assert!(core::ptr::eq(actual, &error));
    }
}
