//! Synchronous control: identical arithmetic and two host calls, without Rust await.
pub fn compute<F, E>(a: i32, b: i32, mut add: F) -> Result<i32, E>
where
    F: FnMut(i32, i32) -> Result<i32, E>,
{
    let first = add(a, b)?;
    add(first, 1)
}
