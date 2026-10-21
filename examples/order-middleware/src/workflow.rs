//! Shared business rules; only the generated binding/executor changes by backend.
use crate::{Failure, Line, OrderRequest, Outcome, Receipt};
use alloc::{string::String, vec::Vec};
use core::future::Future;
fn trim(value: &str) -> &str {
    value.trim_matches([' ', '\t', '\r', '\n'])
}
fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub async fn process<E, F, Fut>(value: OrderRequest, authorize: F) -> Result<Outcome, E>
where
    F: FnOnce(String, u32) -> Fut,
    Fut: Future<Output = Result<bool, E>>,
{
    use Failure::*;
    let Some(tenant) = value.tenant else {
        return Ok(Err(MissingTenant));
    };
    let tenant = trim(&tenant);
    if !valid_key(tenant) {
        return Ok(Err(InvalidTenant));
    }
    let customer = trim(&value.customer);
    if customer.is_empty() || customer.len() > 80 {
        return Ok(Err(InvalidCustomer));
    }
    if value.items.is_empty() {
        return Ok(Err(EmptyOrder));
    }
    if value.items.len() > 128 {
        return Ok(Err(TooManyItems));
    }
    let mut items: Vec<Line> = Vec::new();
    let mut total = 0u32;
    for mut item in value.items {
        let sku = trim(&item.sku);
        if !valid_key(sku) {
            return Ok(Err(InvalidSku));
        }
        if !(1..=100).contains(&item.quantity) {
            return Ok(Err(InvalidQuantity));
        }
        if !(1..=1_000_000).contains(&item.price) {
            return Ok(Err(InvalidPrice));
        }
        item.sku = String::from(sku);
        item.sku.make_ascii_uppercase();
        let amount = item.quantity * item.price;
        if let Some(existing) = items.iter_mut().find(|v| v.sku == item.sku) {
            if existing.price != item.price {
                return Ok(Err(ConflictingPrice));
            }
            existing.quantity += item.quantity;
            if existing.quantity > 100 {
                return Ok(Err(InvalidQuantity));
            }
        } else {
            items.push(item);
        }
        let Some(next) = total.checked_add(amount) else {
            return Ok(Err(AmountOverflow));
        };
        total = next;
    }
    if !authorize(String::from(tenant), total).await? {
        return Ok(Err(Denied));
    }
    Ok(Ok(Receipt {
        customer: String::from(customer),
        items,
        total,
        preview: value.preview,
    }))
}
