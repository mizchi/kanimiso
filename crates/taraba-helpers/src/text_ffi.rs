pub(crate) mod values {
    #[link(wasm_import_module = "taraba:helpers/values@0.1.0")]
    unsafe extern "C" {
        pub fn clone(id: u32) -> u32;
        pub fn drop(id: u32);
    }
}
#[cfg(feature = "strings")]
pub(crate) mod strings {
    #[link(wasm_import_module = "taraba:helpers/strings@0.1.0")]
    unsafe extern "C" {
        #[link_name = "from-utf8"]
        pub fn from_utf8(ptr: *const u8, len: usize) -> u32;
        #[link_name = "utf8-len"]
        pub fn utf8_len(id: u32) -> usize;
        #[link_name = "utf16-len"]
        pub fn utf16_len(id: u32) -> u32;
        #[link_name = "copy-utf8"]
        pub fn copy_utf8(id: u32, ptr: *mut u8, capacity: usize) -> usize;
        pub fn normalize(id: u32, form: u32) -> u32;
        #[link_name = "to-uppercase"]
        pub fn to_uppercase(id: u32) -> u32;
        #[link_name = "to-lowercase"]
        pub fn to_lowercase(id: u32) -> u32;
        pub fn trim(id: u32) -> u32;
        pub fn equals(a: u32, b: u32) -> u32;
        #[cfg(feature = "iterator")]
        #[link_name = "code-points"]
        pub fn code_points(id: u32) -> u32;
    }
}
#[cfg(feature = "iterator")]
pub(crate) mod iterator {
    #[link(wasm_import_module = "taraba:helpers/iterator@0.1.0")]
    unsafe extern "C" {
        pub fn next(id: u32) -> u32;
        pub fn close(id: u32);
    }
}
#[cfg(feature = "segmenter")]
pub(crate) mod segmenter {
    #[link(wasm_import_module = "taraba:helpers/segmenter@0.1.0")]
    unsafe extern "C" {
        pub fn new(locale: u32, granularity: u32) -> u32;
        pub fn segment(id: u32, text: u32) -> u32;
        pub fn text(id: u32) -> u32;
        pub fn index(id: u32) -> u32;
        #[link_name = "word-like"]
        pub fn word_like(id: u32) -> u32;
    }
}
#[cfg(feature = "encoding")]
pub(crate) mod encoding {
    #[link(wasm_import_module = "taraba:helpers/encoding@0.1.0")]
    unsafe extern "C" {
        pub fn new(label: u32) -> u32;
        pub fn decode(id: u32, ptr: *const u8, len: usize) -> u32;
    }
}
