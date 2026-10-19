// Production promise.rs/value.rs are copied unchanged; only the FFI host is modeled.
pub use value::JsValue;
mod promise;
mod value;
mod ffi {
    pub static mut PROMISE: bool = false;
    pub static mut RESULT: bool = false;
    pub static mut WAIT: bool = false;
    pub static mut ID: u32 = 0;
    pub unsafe fn release(value: u32) {
        match value {
            0 => {}
            1 => {
                assert!(PROMISE, "Promise root must be released exactly once");
                PROMISE = false;
            }
            2 => {
                assert!(RESULT, "result root must be released exactly once");
                RESULT = false;
            }
            _ => unreachable!(),
        }
    }
    pub unsafe fn subscribe(value: u32, _: u32) -> u32 {
        assert_eq!(value, 1);
        assert!(PROMISE && !WAIT);
        WAIT = true;
        ID
    }
    pub unsafe fn unsubscribe(id: u32) {
        assert!(id == ID);
        WAIT = false; // Retirement is idempotent, as with the JS wait registry.
    }
    // Numeric conversions, retain and exhaustion are outside this proof.
    pub unsafe fn number(_: i32) -> u32 {
        unreachable!()
    }
    pub unsafe fn as_i32(_: u32) -> f64 {
        unreachable!()
    }
    pub unsafe fn retain(_: u32) {
        unreachable!()
    }
    pub unsafe fn exhausted() -> u32 {
        unreachable!()
    }
}
