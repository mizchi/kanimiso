export type Binding = (...args: never[]) => unknown;
export interface HostOptions {
  /** Application functions imported from the `app` Wasm module. Exceptions are fatal. */
  bindings?: Readonly<Record<string, Binding>>;
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
  cancel(token: number): boolean;
  activeTasks(): number[];
  stats(): RuntimeStats;
  dispose(): void;
  attach(exports: WebAssembly.Exports): void;
}
export function createHost(options?: HostOptions): Host;
