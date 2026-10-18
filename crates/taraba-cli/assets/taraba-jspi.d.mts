/** Default scalar WIT/Core JSPI profile. Requires Safari 27+ or a JSPI-capable V8. */
export interface JspiOptions {
  bindings?: Readonly<Record<string, (...args: never[]) => unknown>>;
  compileOptions?: { builtins?: string[]; importedStringConstants?: string };
}
export interface JspiHost {
  /** Serialized per instance, including I/O waits. Bindings must not await same-instance reentry. */
  call<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  promise<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  stats(): {
    calls: number;
    completions: number;
    queued: number;
    dead: boolean;
  };
}
/** A host rejection or Wasm trap permanently closes the instance. No cancellation or Rust Drop guarantee. */
export function instantiate(
  source: BufferSource | WebAssembly.Module,
  options?: JspiOptions,
): Promise<JspiHost>;
