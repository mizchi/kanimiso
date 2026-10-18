const debug = typeof __JSC_DEBUG__ === "undefined" ? true : __JSC_DEBUG__;
export const failure = (code) => Object.assign(new Error(code), { code });

// Owns JS snapshots only. Wasm trampolines own activation references and perform
// the atomic handoff back to Rust; Promise callbacks never restore guest memory.
export function createStacks(alive) {
  const roots = new Set();
  let memory,
    pointer,
    low,
    high,
    copied = 0,
    peak = 0;
  const requireRoot = (root, phase) => {
    alive();
    if (!roots.has(root) || root.phase_ !== phase) throw failure("JC3");
  };
  const stats = debug
    ? () => ({
        roots: roots.size,
        snapshot_bytes: [...roots].reduce(
          (n, r) => n + (r.saved_?.byteLength ?? 0),
          0,
        ),
        copied_bytes: copied,
        peak_snapshot_bytes: peak,
      })
    : null;
  return {
    attach(exports) {
      memory = exports.memory;
      pointer = exports.__stack_pointer;
      low = exports.__stack_low?.value;
      high = exports.__stack_high?.value;
      if (
        exports.rt_jspi_stack?.value !== 1 ||
        !(memory instanceof WebAssembly.Memory) ||
        !(pointer instanceof WebAssembly.Global) ||
        (typeof SharedArrayBuffer !== "undefined" &&
          memory.buffer instanceof SharedArrayBuffer) ||
        !Number.isInteger(low) ||
        !Number.isInteger(high) ||
        low < 0 ||
        high <= low ||
        low % 16 ||
        high % 16 ||
        high > memory.buffer.byteLength ||
        pointer.value !== high
      )
        throw failure("JC1");
      try {
        pointer.value = high;
      } catch {
        throw failure("JC1");
      }
    },
    imports: {
      enter() {
        alive();
        if (!pointer || pointer.value !== high) throw failure("JC1");
        const root = { phase_: 1, bottom_: high, saved_: null };
        roots.add(root);
        return root;
      },
      suspend(root, bottom) {
        requireRoot(root, 1);
        if (
          !Number.isInteger(bottom) ||
          bottom < low ||
          bottom > high ||
          bottom % 16
        )
          throw failure("JC2");
        root.saved_ = new Uint8Array(memory.buffer).slice(bottom, high);
        root.bottom_ = bottom;
        root.phase_ = 2;
        pointer.value = high;
        if (debug) {
          copied += root.saved_.byteLength;
          peak = Math.max(peak, stats().snapshot_bytes);
        }
      },
      resume(root) {
        requireRoot(root, 2);
        if (pointer.value !== high) throw failure("JC1");
        // memory.grow detaches the old buffer: obtain a fresh view on every restore.
        new Uint8Array(memory.buffer).set(root.saved_, root.bottom_);
        if (debug) copied += root.saved_.byteLength;
        root.saved_ = null;
        root.phase_ = 1;
        return root.bottom_;
      },
      leave(root) {
        requireRoot(root, 1);
        root.phase_ = 0;
        roots.delete(root);
        pointer.value = high;
      },
    },
    close() {
      for (const root of roots) {
        root.saved_ = null;
        root.phase_ = 0;
      }
      roots.clear();
      memory = pointer = null;
    },
    ...(debug ? { stats } : {}),
  };
}
