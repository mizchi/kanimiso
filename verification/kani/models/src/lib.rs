//! Cross-language host protocol model; not a proof of the JavaScript engine.
#[derive(Clone, Copy)]
pub struct Ids {
    next: u64,
    last: u32,
}
impl Ids {
    pub fn new(first: u32, last: u32) -> Self {
        assert!(first > 0 && first <= last);
        Self {
            next: first as u64,
            last,
        }
    }
    pub fn issue(&mut self) -> u32 {
        if self.next > self.last as u64 {
            return 0;
        }
        let id = self.next as u32;
        self.next += 1;
        id
    }
    pub fn clear(&mut self) { /* IDs are never reset. */
    }
}
#[cfg(kani)]
mod proofs {
    use super::*;
    #[kani::proof]
    fn ids_never_wrap_and_exhaustion_is_permanent() {
        let first: u32 = kani::any();
        let last: u32 = kani::any();
        kani::assume(first > 0 && first <= last);
        let mut ids = Ids::new(first, last);
        let a = ids.issue();
        ids.clear();
        let b = ids.issue();
        assert_eq!(a, first);
        if a == last {
            assert_eq!(b, 0);
            assert_eq!(ids.issue(), 0);
        } else {
            assert_eq!(b, a + 1);
            assert_ne!(a, b);
        }
    }
    #[kani::proof]
    fn arbitrary_reachable_id_state_preserves_invariant() {
        let last: u32 = kani::any();
        let next: u64 = kani::any();
        kani::assume(last > 0 && next >= 1 && next <= last as u64 + 1);
        let mut ids = Ids { next, last };
        let old = ids.next;
        let id = ids.issue();
        assert!(ids.next >= old && ids.next <= last as u64 + 1);
        if old <= last as u64 {
            assert_ne!(id, 0);
            assert_eq!(id as u64, old);
            assert_eq!(ids.next, old + 1);
        } else {
            assert_eq!(id, 0);
            assert_eq!(ids.next, old);
        }
    }
    // Red control: a deliberately incorrect wrapping-u32 design must be rejected by Kani.
    #[cfg(feature = "red-control")]
    #[kani::proof]
    fn red_wrapping_id_counter_reuses_zero() {
        let mut next: u32 = kani::any();
        kani::assume(next > 0);
        next = next.wrapping_add(1);
        assert_ne!(next, 0);
    }
}
