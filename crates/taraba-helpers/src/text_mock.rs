//! Native/Miri ownership model, not an implementation of ICU or WHATWG codecs.
#![allow(dead_code)]
use std::{
    cell::RefCell,
    collections::BTreeMap,
    string::{String, ToString},
    vec::Vec,
};
#[derive(Clone)]
enum Value {
    Text(String),
    Iterator { items: Vec<Value>, at: usize },
    Segment { text: String, index: u32, word: u32 },
    Segmenter(u32),
    Decoder,
}
#[derive(Default)]
struct State {
    next: u32,
    roots: BTreeMap<u32, Value>,
    pulls: usize,
    closes: usize,
}
impl State {
    fn put(&mut self, value: Value) -> u32 {
        self.next += 1;
        self.roots.insert(self.next, value);
        self.next
    }
    fn text(&self, id: u32) -> &str {
        let Value::Text(s) = &self.roots[&id] else {
            panic!("wrong model root type")
        };
        s
    }
}
std::thread_local! { static STATE:RefCell<State> = RefCell::new(State::default()); }
pub fn assert_empty() {
    STATE.with_borrow(|s| assert!(s.roots.is_empty()));
}
pub fn iterator_counts() -> (usize, usize) {
    STATE.with_borrow(|s| (s.pulls, s.closes))
}
pub fn assert_iterator_counts(pulls: usize, closes: usize) {
    assert_eq!(iterator_counts(), (pulls, closes));
}
pub(crate) fn text(id: u32) -> String {
    STATE.with_borrow(|s| s.text(id).into())
}
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    unsafe { core::slice::from_raw_parts(ptr, len) }
}
pub mod values {
    use super::*;
    pub unsafe fn clone(id: u32) -> u32 {
        STATE.with_borrow_mut(|s| {
            let value = s.roots[&id].clone();
            s.put(value)
        })
    }
    pub unsafe fn drop(id: u32) {
        STATE.with_borrow_mut(|s| assert!(s.roots.remove(&id).is_some()));
    }
}
pub mod strings {
    use super::*;
    pub unsafe fn from_utf8(ptr: *const u8, len: usize) -> u32 {
        let text = core::str::from_utf8(unsafe { bytes(ptr, len) })
            .unwrap()
            .to_string();
        STATE.with_borrow_mut(|s| s.put(Value::Text(text)))
    }
    pub unsafe fn utf8_len(id: u32) -> usize {
        STATE.with_borrow(|s| s.text(id).len())
    }
    pub unsafe fn utf16_len(id: u32) -> u32 {
        STATE.with_borrow(|s| s.text(id).encode_utf16().count() as u32)
    }
    pub unsafe fn copy_utf8(id: u32, ptr: *mut u8, capacity: usize) -> usize {
        STATE.with_borrow(|s| {
            let text = s.text(id);
            let mut len = capacity.min(text.len());
            while !text.is_char_boundary(len) {
                len -= 1;
            }
            unsafe {
                core::ptr::copy_nonoverlapping(text.as_ptr(), ptr, len);
            }
            len
        })
    }
    pub unsafe fn normalize(id: u32, _: u32) -> u32 {
        unsafe { values::clone(id) }
    } // ASCII ownership probe only.
    pub unsafe fn to_uppercase(id: u32) -> u32 {
        STATE.with_borrow_mut(|s| {
            let text = s.text(id).to_uppercase();
            s.put(Value::Text(text))
        })
    }
    pub unsafe fn to_lowercase(id: u32) -> u32 {
        STATE.with_borrow_mut(|s| {
            let text = s.text(id).to_lowercase();
            s.put(Value::Text(text))
        })
    }
    pub unsafe fn trim(id: u32) -> u32 {
        STATE.with_borrow_mut(|s| {
            let text = s.text(id).trim().into();
            s.put(Value::Text(text))
        })
    }
    pub unsafe fn equals(a: u32, b: u32) -> u32 {
        STATE.with_borrow(|s| u32::from(s.text(a) == s.text(b)))
    }
    pub unsafe fn code_points(id: u32) -> u32 {
        STATE.with_borrow_mut(|s| {
            let items = s
                .text(id)
                .chars()
                .map(|c| Value::Text(c.to_string()))
                .collect();
            s.put(Value::Iterator { items, at: 0 })
        })
    }
}
pub mod iterator {
    use super::*;
    pub unsafe fn next(id: u32) -> u32 {
        STATE.with_borrow_mut(|s| {
            s.pulls += 1;
            let Value::Iterator { items, at } = s.roots.get_mut(&id).unwrap() else {
                panic!("wrong iterator root")
            };
            let item = items.get(*at).cloned();
            *at += 1;
            item.map_or(0, |item| s.put(item))
        })
    }
    pub unsafe fn close(id: u32) {
        STATE.with_borrow_mut(|s| {
            assert!(matches!(s.roots.remove(&id), Some(Value::Iterator { .. })));
            s.closes += 1;
        });
    }
}
pub mod segmenter {
    use super::*;
    pub unsafe fn new(locale: u32, granularity: u32) -> u32 {
        STATE.with_borrow_mut(|s| {
            if s.text(locale) == "invalid_locale" {
                0
            } else {
                s.put(Value::Segmenter(granularity))
            }
        })
    }
    pub unsafe fn segment(id: u32, text: u32) -> u32 {
        STATE.with_borrow_mut(|s| {
            let Value::Segmenter(granularity) = s.roots[&id] else {
                panic!("wrong segmenter root")
            };
            let mut index = 0;
            let items = s
                .text(text)
                .chars()
                .map(|c| {
                    let segment = Value::Segment {
                        text: c.to_string(),
                        index,
                        word: if granularity == 1 {
                            u32::from(c.is_alphanumeric())
                        } else {
                            2
                        },
                    };
                    index += c.len_utf16() as u32;
                    segment
                })
                .collect();
            s.put(Value::Iterator { items, at: 0 })
        })
    }
    pub unsafe fn text(id: u32) -> u32 {
        STATE.with_borrow_mut(|s| {
            let Value::Segment { text, .. } = &s.roots[&id] else {
                panic!("wrong segment root")
            };
            let text = text.clone();
            s.put(Value::Text(text))
        })
    }
    pub unsafe fn index(id: u32) -> u32 {
        STATE.with_borrow(|s| {
            let Value::Segment { index, .. } = s.roots[&id] else {
                panic!("wrong segment root")
            };
            index
        })
    }
    pub unsafe fn word_like(id: u32) -> u32 {
        STATE.with_borrow(|s| {
            let Value::Segment { word, .. } = s.roots[&id] else {
                panic!("wrong segment root")
            };
            word
        })
    }
}
pub mod encoding {
    use super::*;
    pub unsafe fn new(label: u32) -> u32 {
        STATE.with_borrow_mut(|s| {
            if s.text(label) == "utf-8" {
                s.put(Value::Decoder)
            } else {
                0
            }
        })
    }
    pub unsafe fn decode(id: u32, ptr: *const u8, len: usize) -> u32 {
        assert!(STATE.with_borrow(|s| matches!(s.roots[&id], Value::Decoder)));
        match core::str::from_utf8(unsafe { bytes(ptr, len) }) {
            Ok(text) => STATE.with_borrow_mut(|s| s.put(Value::Text(text.into()))),
            Err(_) => 0,
        }
    }
}
