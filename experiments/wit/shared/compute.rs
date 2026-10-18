//! One algorithm compiled into both runtimes. Input and intermediate arithmetic is i32.
pub async fn compute<F, Fut, E>(a: i32, b: i32, mut add: F) -> Result<i32, E>
where
    F: FnMut(i32, i32) -> Fut,
    Fut: core::future::Future<Output = Result<i32, E>>,
{
    let first = add(a, b).await?;
    add(first, 1).await
}
