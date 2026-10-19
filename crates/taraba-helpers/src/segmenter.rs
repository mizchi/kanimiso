//! Intl.Segmenter semantics and locale data from the host JS engine.
use crate::{
    handle::Root,
    iter::{FromRoot, JsIterator},
    string::JsString,
    text_ffi::segmenter,
};

#[derive(Clone, Copy)]
#[repr(u32)]
pub enum Granularity {
    Grapheme,
    Word,
    Sentence,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidLocale;
pub struct Segmenter {
    root: Root,
}
impl Segmenter {
    /// Empty locale selects the engine default; use an explicit locale for
    /// repeatable intent. Unicode/ICU versions can still differ across engines.
    pub fn new(locale: &str, granularity: Granularity) -> Result<Self, InvalidLocale> {
        let locale = JsString::from(locale);
        let id = unsafe { segmenter::new(locale.root.raw(), granularity as u32) };
        if id == 0 {
            Err(InvalidLocale)
        } else {
            Ok(Self {
                root: unsafe { Root::from_raw(id) },
            })
        }
    }
    /// Cursor owns its source in JS and may outlive both this object and text.
    pub fn segment(&self, text: &JsString) -> JsIterator<Segment> {
        unsafe {
            JsIterator::from_root(Root::from_raw(segmenter::segment(
                self.root.raw(),
                text.root.raw(),
            )))
        }
    }
}
pub struct Segment {
    root: Root,
}
impl Segment {
    pub fn text(&self) -> JsString {
        unsafe { JsString::from_root(Root::from_raw(segmenter::text(self.root.raw()))) }
    }
    /// UTF-16 code-unit index in the original input; not a Rust &str byte index.
    pub fn index_utf16(&self) -> u32 {
        unsafe { segmenter::index(self.root.raw()) }
    }
    /// None for grapheme/sentence granularity; Some only for word segmentation.
    pub fn is_word_like(&self) -> Option<bool> {
        match unsafe { segmenter::word_like(self.root.raw()) } {
            2 => None,
            value => Some(value != 0),
        }
    }
}
impl FromRoot for Segment {
    fn from_root(root: Root) -> Self {
        Self { root }
    }
}
