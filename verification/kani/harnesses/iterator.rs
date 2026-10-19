// Production Root and JsIterator are copied unchanged. The host is modeled.
mod handle;
mod iter;
mod text_ffi {
    pub static mut CURSOR: u32 = 0;
    pub static mut ITEM: u32 = 0;
    pub static mut HAS_ITEM: bool = false;
    pub static mut CURSOR_LIVE: bool = true;
    pub static mut ITEM_LIVE: bool = false;
    pub static mut NEXTS: u8 = 0;
    pub static mut CLOSES: u8 = 0;
    pub static mut CURSOR_DROPS: u8 = 0;
    pub static mut ITEM_DROPS: u8 = 0;
    pub mod values {
        use super::*;
        pub unsafe fn clone(_: u32) -> u32 {
            unreachable!()
        } // Outside this proof.
        pub unsafe fn drop(id: u32) {
            unsafe {
                if id == CURSOR {
                    assert!(CURSOR_LIVE && CURSOR_DROPS == 0 && CLOSES == 0);
                    CURSOR_LIVE = false;
                    CURSOR_DROPS += 1;
                } else {
                    assert!(id == ITEM && ITEM_LIVE && ITEM_DROPS == 0);
                    ITEM_LIVE = false;
                    ITEM_DROPS += 1;
                }
            }
        }
    }
    pub mod iterator {
        use super::*;
        pub unsafe fn next(id: u32) -> u32 {
            unsafe {
                assert!(id == CURSOR && CURSOR_LIVE);
                let first = NEXTS == 0;
                NEXTS += 1;
                if first && HAS_ITEM {
                    assert!(!ITEM_LIVE);
                    ITEM_LIVE = true;
                    ITEM
                } else {
                    0
                }
            }
        }
        pub unsafe fn close(id: u32) {
            unsafe {
                assert!(id == CURSOR && CURSOR_LIVE && CURSOR_DROPS == 0 && CLOSES == 0);
                CURSOR_LIVE = false;
                CLOSES += 1;
            }
        }
    }
}
struct Item {
    _root: handle::Root,
}
impl iter::FromRoot for Item {
    fn from_root(root: handle::Root) -> Self {
        Self { _root: root }
    }
}
#[kani::proof]
#[kani::unwind(4)]
fn iterator_is_fused_and_releases_owned_items_independently() {
    let cursor: u32 = kani::any();
    kani::assume(cursor != 0);
    let has_item: bool = kani::any();
    let mode: u8 = kani::any();
    kani::assume(mode < 3);
    unsafe {
        text_ffi::CURSOR = cursor;
        text_ffi::ITEM = if cursor == 1 { 2 } else { 1 };
        text_ffi::HAS_ITEM = has_item;
    }
    let mut iter = iter::JsIterator::<Item>::from_root(unsafe { handle::Root::from_raw(cursor) });
    if mode == 0 {
        drop(iter);
        unsafe {
            assert!(text_ffi::NEXTS == 0 && text_ffi::CLOSES == 1);
        }
    } else {
        let item = iter.next();
        assert!(item.is_some() == has_item);
        if mode == 2 {
            assert!(iter.next().is_none());
            let calls = unsafe { text_ffi::NEXTS };
            assert!(iter.next().is_none());
            assert!(iter.next().is_none());
            unsafe {
                assert!(text_ffi::NEXTS == calls);
            }
        }
        drop(iter);
        unsafe {
            assert!(!text_ffi::CURSOR_LIVE);
            assert!(text_ffi::ITEM_LIVE == has_item);
            assert!(text_ffi::CLOSES == u8::from(mode == 1 && has_item));
        }
        drop(item);
    }
    unsafe {
        assert!(!text_ffi::CURSOR_LIVE && !text_ffi::ITEM_LIVE);
        assert!(text_ffi::CLOSES + text_ffi::CURSOR_DROPS == 1);
        assert!(text_ffi::ITEM_DROPS == u8::from(mode != 0 && has_item));
    }
}
