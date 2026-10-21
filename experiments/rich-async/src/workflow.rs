//! Shared model and algorithm: both backends call this exact Future.
use crate::Packet;
use alloc::string::String;
use core::future::Future;
pub async fn process<E, F, Fut>(
    mut value: Packet,
    transform: F,
) -> Result<Result<Packet, String>, E>
where
    F: Fn(Packet) -> Fut,
    Fut: Future<Output = Result<Result<Packet, String>, E>>,
{
    if value.id == 0 {
        return Ok(Err(String::from("invalid-id")));
    }
    for step in 0..2u8 {
        value.label.push_str("/rust");
        for (i, byte) in value.payload.iter_mut().enumerate() {
            *byte = byte.wrapping_add((i as u8).wrapping_add(step));
        }
        value = match transform(value).await? {
            Ok(value) => value,
            Err(error) => return Ok(Err(error)),
        };
        value.id = value.id.wrapping_add(1);
    }
    Ok(Ok(value))
}
