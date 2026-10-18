#![cfg_attr(not(feature = "std"), no_std)]
#[cfg(any(
    all(feature = "jspi", feature = "future"),
    all(feature = "jspi", feature = "component"),
    all(feature = "future", feature = "component")
))]
compile_error!("select exactly one backend");
#[global_allocator]
static ALLOCATOR: taraba_allocator::Allocator = taraba_allocator::Allocator::INIT;
#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[cfg(feature = "async-workload")]
#[path = "../../../wit/shared/compute.rs"]
mod workflow;
#[cfg(not(feature = "async-workload"))]
#[path = "../../sync.rs"]
mod workflow;

#[cfg(all(feature = "async-workload", feature = "component"))]
wit_bindgen::generate!({path:"wit/async",world:"app"});
#[cfg(all(feature = "async-workload", feature = "future"))]
wit_bindgen::generate!({path:"wit/future",world:"app"});
#[cfg(any(not(feature = "async-workload"), feature = "jspi"))]
wit_bindgen::generate!({path:"wit/sync",world:"app"});

struct App;
#[cfg(not(feature = "async-workload"))]
impl Guest for App {
    fn run(a: i32, b: i32) -> i32 {
        workflow::compute(a, b, |a, b| Ok::<_, core::convert::Infallible>(add(a, b))).unwrap()
    }
}
#[cfg(all(feature = "async-workload", feature = "jspi"))]
impl Guest for App {
    fn run(a: i32, b: i32) -> i32 {
        use core::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        let mut f = core::pin::pin!(workflow::compute(a, b, |a, b| async move {
            Ok::<_, core::convert::Infallible>(add(a, b))
        }));
        match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(Ok(v)) => v,
            Poll::Ready(Err(e)) => match e {},
            Poll::Pending => core::arch::wasm32::unreachable(),
        }
    }
}
#[cfg(all(feature = "async-workload", feature = "component"))]
impl Guest for App {
    async fn run(a: i32, b: i32) -> i32 {
        workflow::compute(a, b, |a, b| async move {
            Ok::<_, core::convert::Infallible>(add(a, b).await)
        })
        .await
        .unwrap()
    }
}
#[cfg(all(feature = "async-workload", feature = "future"))]
::taraba::export_runtime!();
#[cfg(all(feature = "async-workload", feature = "future"))]
impl Guest for App {
    fn run(a: i32, b: i32) -> Promise {
        let f = workflow::compute(a, b, |a, b| async move {
            // Exact existing Core ownership bridge; not Canonical resource handles.
            let p = unsafe { ::taraba::JsPromise::from_abi(add(a, b).take_handle()) };
            p.into_future()
                .await?
                .as_i32()
                .map_err(|e| ::taraba::JsValue::from_i32(e.0))
        });
        let p =
            ::taraba::future_to_promise(async move { f.await.map(::taraba::JsValue::from_i32) });
        unsafe { Promise::from_handle(p.into_abi()) }
    }
}
export!(App);
