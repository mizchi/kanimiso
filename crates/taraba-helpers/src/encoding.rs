//! Reusable fatal TextDecoder. Each decode is a complete, non-streaming input.
use crate::{handle::Root, string::JsString, text_ffi::encoding};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidEncoding;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeError;
pub struct Decoder {
    root: Root,
}
impl Decoder {
    /// WHATWG encoding label; malformed input fails instead of replacing bytes.
    /// A leading BOM is preserved (`ignoreBOM: true`).
    pub fn new(label: &str) -> Result<Self, InvalidEncoding> {
        let label = JsString::from(label);
        let id = unsafe { encoding::new(label.root.raw()) };
        if id == 0 {
            Err(InvalidEncoding)
        } else {
            Ok(Self {
                root: unsafe { Root::from_raw(id) },
            })
        }
    }
    pub fn decode(&self, bytes: &[u8]) -> Result<JsString, DecodeError> {
        // SAFETY: decoding is synchronous and retains no input pointer/view.
        let id = unsafe { encoding::decode(self.root.raw(), bytes.as_ptr(), bytes.len()) };
        if id == 0 {
            Err(DecodeError)
        } else {
            Ok(JsString::from_root(unsafe { Root::from_raw(id) }))
        }
    }
}
