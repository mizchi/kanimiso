/** Default scalar WIT/Core JSPI profile. Requires Safari 27+ or a JSPI-capable V8. */
export interface JspiHostOptions {
  bindings?: Readonly<Record<string, (...args: never[]) => unknown>>;
}
export interface JspiHost {
  readonly imports: WebAssembly.Imports;
  /** Attach once after native instantiation. Never call raw instance exports. */
  dispose(): void;
  attach(exports: WebAssembly.Exports): void;
  /** Serialized per instance. Rejection/trap closes the instance; no cancellation or Rust Drop guarantee. Bindings must not await same-instance reentry. */
  call<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  stats(): {
    calls: number;
    completions: number;
    queued: number;
    dead: boolean;
  };
}
export function createHost(
  options?: JspiHostOptions,
  exportNames?: readonly string[],
): JspiHost;
