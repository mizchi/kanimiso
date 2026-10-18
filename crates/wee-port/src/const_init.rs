// Derived from wee_alloc_bw @ 9a9adc2106df80abd25501194275d7d51a1ba4c4.
// MPL-2.0: see ../LICENSE. Modified for this wasm32-only experiment.
/// Anything that can be initialized with a `const` value.
pub(crate) trait ConstInit {
    /// The `const` default initializer value for `Self`.
    const INIT: Self;
}

impl<T> ConstInit for *const T {
    const INIT: Self = core::ptr::null();
}
