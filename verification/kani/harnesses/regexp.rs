// Appended to the unchanged production RegExp API prefix. The JS host is modeled.
mod ffi {
    pub static mut ID: u32 = 0;
    pub static mut LIVE: bool = false;
    pub static mut MATCH: bool = false;
    pub static mut RELEASES: u8 = 0;
    unsafe fn borrow(ptr: *const u8, len: usize) {
        let bytes = unsafe { core::slice::from_raw_parts(ptr, len) };
        assert!(core::str::from_utf8(bytes).is_ok());
    }
    pub unsafe fn compile(ptr: *const u8, len: usize) -> u32 {
        unsafe {
            borrow(ptr, len);
            assert!(!LIVE);
            LIVE = ID != 0;
            ID
        }
    }
    pub unsafe fn test(id: u32, ptr: *const u8, len: usize) -> u32 {
        unsafe {
            borrow(ptr, len);
            assert!(LIVE && id == ID);
            u32::from(MATCH)
        }
    }
    pub unsafe fn release(id: u32) {
        unsafe {
            assert!(LIVE && id == ID && RELEASES == 0);
            LIVE = false;
            RELEASES += 1;
        }
    }
}
#[kani::proof]
#[kani::unwind(3)]
fn regexp_owns_each_nonzero_handle_and_releases_once() {
    let id: u32 = kani::any();
    let matched: bool = kani::any();
    let byte: u8 = kani::any();
    kani::assume(byte < 128);
    let bytes = [byte];
    let text = core::str::from_utf8(&bytes).unwrap();
    unsafe {
        ffi::ID = id;
        ffi::MATCH = matched;
    }
    match RegExp::new(text) {
        Ok(re) => {
            assert!(id != 0);
            assert_eq!(re.is_match(text), matched);
            assert_eq!(re.is_match(""), matched);
            drop(re);
            unsafe {
                assert!(!ffi::LIVE);
                assert!(ffi::RELEASES == 1);
            }
        }
        Err(_) => unsafe {
            assert!(id == 0 && !ffi::LIVE && ffi::RELEASES == 0);
        },
    }
}
