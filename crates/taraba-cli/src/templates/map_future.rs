// Map a Future's output without introducing another async state machine.
// Only `future` is structurally pinned; `map` is never exposed through Pin.
struct MapFuture<F, M> {
    future: F,
    map: M,
}
impl<F, M, T> core::future::Future for MapFuture<F, M>
where
    F: core::future::Future,
    M: FnMut(F::Output) -> T,
{
    type Output = T;
    fn poll(
        self: core::pin::Pin<&mut Self>,
        cx: &mut core::task::Context<'_>,
    ) -> core::task::Poll<T> {
        // SAFETY: future remains in the pinned parent until it is dropped in
        // place. Neither this implementation nor a custom Drop moves it.
        // The mapper is a disjoint field and is not structurally pinned.
        let this = unsafe { self.get_unchecked_mut() };
        let future = unsafe { core::pin::Pin::new_unchecked(&mut this.future) };
        future.poll(cx).map(&mut this.map)
    }
}
pub(super) fn map_future<F, M, T>(future: F, map: M) -> impl core::future::Future<Output = T>
where
    F: core::future::Future,
    M: FnMut(F::Output) -> T,
{
    MapFuture { future, map }
}
