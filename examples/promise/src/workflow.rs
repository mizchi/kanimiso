use jsrt::{JsPromise, JsValue};
#[link(wasm_import_module = "$root")]
unsafe extern "C" {
    #[link_name = "add"]
    fn deferred_add(a: i32, b: i32) -> u32;
}
// Both executors compile this exact async algorithm and Promise bridge.
pub async fn compute(a: i32, b: i32) -> Result<JsValue, JsValue> {
    let first = unsafe { JsPromise::from_abi(deferred_add(a, b)) }.await?;
    let first = first.as_i32().map_err(|_| JsValue::from_i32(-2))?;
    unsafe { JsPromise::from_abi(deferred_add(first, 1)) }.await
}
#[cfg(feature = "test-api")]
pub async fn forward(promise: JsPromise) -> Result<JsValue, JsValue> {
    promise.await
}
