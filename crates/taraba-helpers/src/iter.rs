//! Typed, owned JS synchronous iterators with Rust Iterator adapters.
use crate::{handle::Root, text_ffi::iterator};
use core::{iter::FusedIterator, marker::PhantomData};

// Sealed conversion: callers cannot assign a wrong type to a private host root.
pub(crate) trait FromRoot {
    fn from_root(root: Root) -> Self;
}

/// A lazy JS -> Rust iterator. Items own their roots independently of the cursor.
/// Early Drop performs IteratorClose (`return()` when present); normal exhaustion
/// releases the cursor without `return()`. Fused even if the JS cursor is not.
/// This does not adapt AsyncIterator or export a Rust iterator to JS.
pub struct JsIterator<T> {
    root: Option<Root>,
    item: PhantomData<T>,
}
impl<T> JsIterator<T> {
    pub(crate) fn from_root(root: Root) -> Self {
        Self {
            root: Some(root),
            item: PhantomData,
        }
    }
}
impl<T: FromRoot> Iterator for JsIterator<T> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        let root = self.root.as_ref()?;
        // SAFETY: the typed factory owns a synchronous iterator; next borrows
        // it and either returns an owned item of type T or the zero done marker.
        let item = unsafe { iterator::next(root.raw()) };
        if item == 0 {
            self.root = None; // Drop root, without IteratorClose on exhaustion.
            None
        } else {
            Some(T::from_root(unsafe { Root::from_raw(item) }))
        }
    }
}
impl<T: FromRoot> FusedIterator for JsIterator<T> {}
impl<T> Drop for JsIterator<T> {
    fn drop(&mut self) {
        if let Some(root) = self.root.take() {
            // SAFETY: close consumes the owned cursor root before invoking
            // optional JS return(), even when that function throws.
            unsafe { iterator::close(root.into_raw()) }
        }
    }
}
