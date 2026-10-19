use crate::{
    encoding::Decoder,
    iter::JsIterator,
    segmenter::{Granularity, Segmenter},
    string::{JsString, Normalization},
};

#[test]
fn strings_clone_copy_and_outlive_their_rust_source() {
    let input = std::string::String::from("蟹🦀");
    let text = JsString::from(input.as_str());
    drop(input);
    let cloned = text.clone();
    drop(text);
    assert_eq!(cloned.utf16_len(), 3);
    assert_eq!(cloned.utf8_len(), 7);
    let mut bytes = [0; 7];
    assert_eq!(cloned.write_utf8(&mut bytes), 7);
    assert_eq!(core::str::from_utf8(&bytes).unwrap(), "蟹🦀");
    assert!(cloned == JsString::from("蟹🦀"));
    let mut short = [255; 2];
    assert_eq!(cloned.write_utf8(&mut short), 0);
    assert_eq!(short, [255; 2]);
    assert!(JsString::from("abc").normalize(Normalization::Nfc) == JsString::from("abc"));
    assert_eq!(cloned.to_rust_string(), "蟹🦀");
    drop(cloned);
    crate::text_mock::assert_empty();
}

#[cfg(feature = "regexp")]
#[test]
fn regex_borrows_js_strings_and_owns_its_compiled_pattern() {
    let pattern = JsString::from("蟹");
    let regex = crate::regexp::RegExp::new_js(&pattern).unwrap();
    drop(pattern);
    assert!(regex.is_match_js(&JsString::from("蟹")));
    assert!(!regex.is_match_js(&JsString::from("🦀")));
    assert!(crate::regexp::RegExp::new_js(&JsString::from("[")).is_err());
    drop(regex);
    crate::text_mock::assert_empty();
}

#[test]
fn iterators_are_lazy_fused_and_close_only_when_dropped_early() {
    let text = JsString::from("a🦀b");
    let mut iter = text.code_points();
    drop(text);
    assert_eq!(core::mem::size_of::<JsIterator<JsString>>(), 4);
    crate::text_mock::assert_iterator_counts(0, 0);
    let first = iter.next().unwrap();
    assert_eq!(first.to_rust_string(), "a");
    crate::text_mock::assert_iterator_counts(1, 0);
    drop(iter);
    crate::text_mock::assert_iterator_counts(1, 1);
    assert_eq!(first.to_rust_string(), "a");
    drop(first);
    let mut iter = JsString::from("🦀b").code_points();
    assert_eq!(iter.by_ref().count(), 2);
    let calls = crate::text_mock::iterator_counts();
    assert!(iter.next().is_none());
    assert!(iter.next().is_none());
    drop(iter);
    assert_eq!(crate::text_mock::iterator_counts(), calls);
    let taken: std::vec::Vec<_> = JsString::from("abc").code_points().take(1).collect();
    assert_eq!(taken[0].to_rust_string(), "a");
    drop(taken);
    crate::text_mock::assert_empty();
}

#[test]
fn segmentation_owns_its_input_and_decoder_errors_are_recoverable() {
    let segmenter = Segmenter::new("en", Granularity::Grapheme).unwrap();
    let mut segments = segmenter.segment(&JsString::from("🦀a"));
    drop(segmenter);
    let item = segments.next().unwrap();
    assert_eq!(item.index_utf16(), 0);
    assert_eq!(item.is_word_like(), None);
    let text = item.text();
    drop(item);
    drop(segments);
    assert_eq!(text.to_rust_string(), "🦀");
    drop(text);
    assert!(Segmenter::new("invalid_locale", Granularity::Word).is_err());
    assert!(Decoder::new("not-an-encoding").is_err());
    let decoder = Decoder::new("utf-8").unwrap();
    assert!(decoder.decode(&[255]).is_err());
    let decoded = decoder.decode("蟹".as_bytes()).unwrap();
    drop(decoder);
    assert_eq!(decoded.to_rust_string(), "蟹");
    drop(decoded);
    crate::text_mock::assert_empty();
}

#[test]
fn host_handles_are_neither_send_nor_sync() {
    trait AmbiguousSend<A> {
        fn check() {}
    }
    impl<T: ?Sized> AmbiguousSend<()> for T {}
    impl<T: ?Sized + Send> AmbiguousSend<u8> for T {}
    let _ = <JsString as AmbiguousSend<_>>::check;
    let _ = <JsIterator<JsString> as AmbiguousSend<_>>::check;
    let _ = <Segmenter as AmbiguousSend<_>>::check;
    let _ = <Decoder as AmbiguousSend<_>>::check;
    trait AmbiguousSync<A> {
        fn check() {}
    }
    impl<T: ?Sized> AmbiguousSync<()> for T {}
    impl<T: ?Sized + Sync> AmbiguousSync<u8> for T {}
    let _ = <JsString as AmbiguousSync<_>>::check;
    let _ = <JsIterator<JsString> as AmbiguousSync<_>>::check;
    let _ = <Segmenter as AmbiguousSync<_>>::check;
    let _ = <Decoder as AmbiguousSync<_>>::check;
}
