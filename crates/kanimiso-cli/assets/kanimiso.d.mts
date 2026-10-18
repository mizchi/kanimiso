export type Binding = (...args: never[]) => unknown;
export interface HostOptions {
  /** Application functions imported from the `app` Wasm module. Exceptions are fatal. */
  bindings?: Readonly<Record<string, Binding>>;
  /** Legacy example I/O provider; application code should use bindings. */
  deferredAdd?: (a: number, b: number) => unknown;
  tokens?: { first?: number; last?: number };
  maxValues?: number;
}
export interface RuntimeStats {
  polls: number;
  wakes: number;
  requests: number;
  completions: number;
  live_values: number;
  peak_values: number;
  value_table_slots: number;
  value_table_capacity: number;
  live_tasks: number;
  live_waits: number;
  issued_ids: number;
  dead: boolean;
}
export interface Host {
  readonly imports: WebAssembly.Imports;
  call(name: string, ...args: unknown[]): unknown;
  promise<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  cancel(token: number): boolean;
  activeTasks(): number[];
  stats(): RuntimeStats;
  attach(exports: WebAssembly.Exports): void;
  /** Private ownership ABI. Release or consume every nonzero root exactly once. */
  root(value: unknown): number;
  get(slot: number): unknown;
  take(slot: number): unknown;
  release(slot: number): void;
}
export interface InstantiateOptions extends HostOptions {
  compileOptions?: { builtins?: string[]; importedStringConstants?: string };
}
export function createHost(options?: HostOptions): Host;
export function instantiate(
  source: BufferSource | WebAssembly.Module,
  options?: InstantiateOptions,
): Promise<Host>;
