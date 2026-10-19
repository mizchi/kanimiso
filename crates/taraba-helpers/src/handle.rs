use crate::text_ffi::values;
use core::{marker::PhantomData, mem::ManuallyDrop, num::NonZeroU32};

/// One private host root, never transferable to another JS agent or instance.
pub(crate) struct Root {
    id: NonZeroU32,
    local: PhantomData<*mut ()>,
}
impl Root {
    /// # Safety
    /// `id` transfers one nonzero live root from this instance's helper registry.
    pub(crate) unsafe fn from_raw(id: u32) -> Self {
        Self {
            id: unsafe { NonZeroU32::new_unchecked(id) },
            local: PhantomData,
        }
    }
    pub(crate) fn raw(&self) -> u32 {
        self.id.get()
    }
    pub(crate) fn into_raw(self) -> u32 {
        ManuallyDrop::new(self).id.get()
    }
}
impl Clone for Root {
    fn clone(&self) -> Self {
        // SAFETY: clone borrows a live root and returns another owned root.
        unsafe { Self::from_raw(values::clone(self.raw())) }
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        // SAFETY: each root ID is owned exactly once; cloning creates a new ID.
        unsafe { values::drop(self.raw()) }
    }
}
