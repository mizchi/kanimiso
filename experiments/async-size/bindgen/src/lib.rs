#![cfg_attr(not(feature = "std"), no_std)]
#[cfg(all(feature = "embassy", not(feature = "std")))]
compile_error!("Embassy platform-wasm links std; do not label this profile no_std");
#[cfg(all(
    any(feature = "tokio", feature = "async-executor", feature = "async-std"),
    not(feature = "std")
))]
compile_error!("These executor profiles link std; do not label them no_std");
#[cfg(not(feature = "wee"))]
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(feature = "wee")]
#[global_allocator]
static ALLOCATOR: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

use wasm_bindgen::prelude::*;
#[cfg(feature = "async-workload")]
#[path = "../../../wit/shared/compute.rs"]
mod workflow;
#[cfg(not(feature = "async-workload"))]
#[path = "../../sync.rs"]
mod workflow;

// Host injection is per wasm-bindgen module/instance, using the documented setter.
#[wasm_bindgen(module = "/io.mjs")]
extern "C" {
    #[cfg(feature = "async-workload")]
    #[wasm_bindgen(js_name=add)]
    fn add_async(a: i32, b: i32) -> js_sys::Promise;
    #[cfg(not(feature = "async-workload"))]
    #[wasm_bindgen(js_name=add)]
    fn add_sync(a: i32, b: i32) -> i32;
}
#[cfg(feature = "async-workload")]
async fn compute(a: i32, b: i32) -> Result<i32, JsValue> {
    workflow::compute(a, b, |a, b| async move {
        let v = wasm_bindgen_futures::JsFuture::from(add_async(a, b)).await?;
        let n = v.as_f64().ok_or_else(|| JsValue::from_f64(-2.))?;
        if n < i32::MIN as f64 || n > i32::MAX as f64 || n as i32 as f64 != n {
            return Err(JsValue::from_f64(-2.));
        }
        Ok(n as i32)
    })
    .await
}
#[cfg(not(feature = "async-workload"))]
#[wasm_bindgen]
pub fn run(a: i32, b: i32) -> i32 {
    workflow::compute(a, b, |a, b| {
        Ok::<_, core::convert::Infallible>(add_sync(a, b))
    })
    .unwrap()
}
#[cfg(all(
    feature = "async-workload",
    not(any(
        feature = "embassy",
        feature = "tokio",
        feature = "async-executor",
        feature = "async-std",
        feature = "futures-unordered"
    ))
))]
#[wasm_bindgen]
pub fn run(a: i32, b: i32) -> js_sys::Promise {
    wasm_bindgen_futures::future_to_promise(async move { compute(a, b).await.map(JsValue::from) })
}
#[cfg(all(
    feature = "async-workload",
    any(
        feature = "tokio",
        feature = "async-executor",
        feature = "async-std",
        feature = "futures-unordered"
    )
))]
mod executors;
#[cfg(all(
    feature = "async-workload",
    any(
        feature = "tokio",
        feature = "async-executor",
        feature = "async-std",
        feature = "futures-unordered"
    )
))]
#[wasm_bindgen]
pub fn run(a: i32, b: i32) -> js_sys::Promise {
    wasm_bindgen_futures::future_to_promise(async move {
        executors::execute(a, b).await.map(JsValue::from)
    })
}
#[cfg(all(feature = "async-workload", feature = "embassy"))]
mod embassy {
    use super::*;
    std::thread_local! {
        static SPAWNER: embassy_executor::Spawner = {
            let e=std::boxed::Box::leak(std::boxed::Box::new(embassy_executor::Executor::new()));
            let mut s=None;
            e.start(|spawner|s=Some(spawner));
            s.unwrap()
        };
    }
    #[embassy_executor::task(pool_size = 1024)]
    async fn worker(a: i32, b: i32, resolve: js_sys::Function, reject: js_sys::Function) {
        let (callback, value) = match compute(a, b).await {
            Ok(v) => (resolve, JsValue::from(v)),
            Err(e) => (reject, e),
        };
        callback.call1(&JsValue::undefined(), &value).unwrap();
    }
    #[wasm_bindgen]
    pub fn run(a: i32, b: i32) -> js_sys::Promise {
        js_sys::Promise::new(
            &mut |resolve, reject| match worker(a, b, resolve, reject.clone()) {
                Ok(token) => SPAWNER.with(|s| s.spawn(token)),
                Err(_) => {
                    reject
                        .call1(&JsValue::undefined(), &JsValue::from_f64(-5.))
                        .unwrap();
                }
            },
        )
    }
}
