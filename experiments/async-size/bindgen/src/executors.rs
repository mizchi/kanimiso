//! Private size fixtures. All paths schedule the same compute Future.
use super::*;

#[cfg(feature = "tokio")]
std::thread_local! {
    static TOKIO: std::rc::Rc<tokio::task::LocalSet> = {
        use core::future::{pending, poll_fn, Future};
        use core::task::Poll;
        let runtime = tokio::runtime::Builder::new_current_thread().build()
            .unwrap_or_else(|_| core::arch::wasm32::unreachable());
        let local = std::rc::Rc::new(tokio::task::LocalSet::new());
        let driver = local.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let mut running = core::pin::pin!(driver.run_until(pending::<()>()));
            // block_on's root always returns immediately. The real pending
            // Future keeps the JS waker, so Tokio never parks the JS thread.
            poll_fn(|cx| runtime.block_on(poll_fn(|_| {
                Poll::Ready(running.as_mut().poll(cx))
            }))).await;
        });
        local
    };
}

#[cfg(feature = "tokio")]
pub(super) async fn execute(a: i32, b: i32) -> Result<i32, JsValue> {
    TOKIO
        .with(|local| local.spawn_local(compute(a, b)))
        .await
        .map_err(|_| JsValue::from_f64(-7.))?
}

#[cfg(feature = "async-executor")]
std::thread_local! {
    static LOCAL: std::rc::Rc<async_executor::LocalExecutor<'static>> = {
        let executor = std::rc::Rc::new(async_executor::LocalExecutor::new());
        let driver = executor.clone();
        wasm_bindgen_futures::spawn_local(async move {
            driver.run(core::future::pending::<()>()).await;
        });
        executor
    };
}

#[cfg(feature = "async-executor")]
pub(super) async fn execute(a: i32, b: i32) -> Result<i32, JsValue> {
    LOCAL.with(|executor| executor.spawn(compute(a, b))).await
}

#[cfg(feature = "async-std")]
pub(super) async fn execute(a: i32, b: i32) -> Result<i32, JsValue> {
    async_std::task::spawn_local(compute(a, b)).await
}

#[cfg(feature = "futures-unordered")]
pub(super) async fn execute(a: i32, b: i32) -> Result<i32, JsValue> {
    use futures_util::{StreamExt, stream::FuturesUnordered};
    let mut tasks = FuturesUnordered::new();
    tasks.push(compute(a, b));
    tasks.next().await.unwrap()
}
