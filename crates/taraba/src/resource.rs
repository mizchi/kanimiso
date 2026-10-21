//! Single-agent storage for generated Rust-owned resources. No raw pointer ABI.
use alloc::{rc::Rc, vec::Vec};
use core::{cell::RefCell, ops::Deref};

fn invalid() -> ! {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::unreachable()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        panic!("resource invariant")
    }
}
/// An owned Rust resource. References stay valid across async calls through Rc.
/// Ownership on the JS side is tracked by the generated, instance-local leases.
pub struct Resource<T: 'static>(Rc<T>);
impl<T: 'static> Resource<T> {
    pub fn new(value: T) -> Self {
        Self(Rc::new(value))
    }
}
impl<T> Deref for Resource<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}
fn next_generation(generation: u16) -> u16 {
    generation.saturating_add(1)
}
struct Entry<T> {
    generation: u16,
    value: Option<Rc<T>>,
}
/// Implementation detail of the generated Core resource ABI.
#[doc(hidden)]
pub struct Store<T> {
    entries: RefCell<Vec<Entry<T>>>,
}
// A taraba guest cannot use shared memory/threads. Native unit tests deliberately
// do not implement Sync, so RefCell/Rc remain confined to their test's thread.
#[cfg(target_arch = "wasm32")]
unsafe impl<T> Sync for Store<T> {}
impl<T: 'static> Store<T> {
    pub const fn new() -> Self {
        Self {
            entries: RefCell::new(Vec::new()),
        }
    }
    pub fn insert(&self, value: Resource<T>) -> u32 {
        let mut entries = self.entries.borrow_mut();
        let index = if let Some(index) = entries
            .iter()
            .position(|e| e.value.is_none() && e.generation < u16::MAX)
        {
            index
        } else {
            if entries.len() >= 65536 {
                invalid();
            }
            entries.push(Entry {
                generation: 1,
                value: None,
            });
            entries.len() - 1
        };
        let entry = &mut entries[index];
        entry.value = Some(value.0);
        (u32::from(entry.generation) << 16) | index as u32
    }
    pub fn borrow(&self, key: u32) -> Resource<T> {
        let entries = self.entries.borrow();
        let entry = entries
            .get((key & 0xffff) as usize)
            .unwrap_or_else(|| invalid());
        if u32::from(entry.generation) != key >> 16 {
            invalid();
        }
        Resource(entry.value.as_ref().unwrap_or_else(|| invalid()).clone())
    }
    pub fn take(&self, key: u32) -> Resource<T> {
        let value = {
            let mut entries = self.entries.borrow_mut();
            let entry = entries
                .get_mut((key & 0xffff) as usize)
                .unwrap_or_else(|| invalid());
            if u32::from(entry.generation) != key >> 16 {
                invalid();
            }
            let value = entry.value.take().unwrap_or_else(|| invalid());
            // Retire exhausted entries forever; stale tokens never alias reuse.
            entry.generation = next_generation(entry.generation);
            value
        };
        Resource(value)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use core::cell::Cell;
    struct Value(Rc<Cell<u32>>);
    impl Drop for Value {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }
    #[test]
    fn borrowed_values_outlive_owner_removal_and_drop_exactly_once() {
        let drops = Rc::new(Cell::new(0));
        let store = Store::new();
        let key = store.insert(Resource::new(Value(drops.clone())));
        let borrowed = store.borrow(key);
        let owned = store.take(key);
        drop(owned);
        assert_eq!(drops.get(), 0);
        drop(borrowed);
        assert_eq!(drops.get(), 1);
    }
    #[test]
    fn reuse_rejects_stale_tokens_and_retires_exhausted_generations() {
        let store = Store::new();
        let first = store.insert(Resource::new(7));
        drop(store.take(first));
        let second = store.insert(Resource::new(9));
        assert_ne!(first, second);
        assert!(
            std::panic::catch_unwind(core::panic::AssertUnwindSafe(|| store.borrow(first)))
                .is_err()
        );
        drop(store.take(second));
        store.entries.borrow_mut()[0].generation = u16::MAX;
        let third = store.insert(Resource::new(11));
        assert_eq!(third & 0xffff, 1);
    }
}

#[cfg(kani)]
mod kani_proofs {
    use super::*;
    use core::cell::Cell;
    struct Value(Rc<Cell<u32>>);
    impl Drop for Value {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }
    #[kani::proof]
    fn removing_an_owner_keeps_borrows_alive_and_drops_once() {
        let count = Rc::new(Cell::new(0));
        let store = Store::new();
        let key = store.insert(Resource::new(Value(count.clone())));
        let borrowed = store.borrow(key);
        drop(store.take(key));
        assert_eq!(count.get(), 0);
        drop(borrowed);
        assert_eq!(count.get(), 1);
    }
    #[kani::proof]
    fn every_live_generation_changes_or_retires_on_transfer() {
        let generation: u16 = kani::any();
        let next = next_generation(generation);
        if generation < u16::MAX {
            assert!(next > generation);
        } else {
            // insert refuses this generation, permanently retiring the slot.
            assert_eq!(next, u16::MAX);
        }
    }
}
