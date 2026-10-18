/// Selects the guest ABI and its matching host. No automatic fallback is used.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ExecutionProfile {
    /// Scalar WIT, serialized JSPI entry, instance-fatal rejection/traps.
    #[default]
    Jspi,
    /// Optional Future executor with concurrent tasks and cancellation.
    Future,
}
