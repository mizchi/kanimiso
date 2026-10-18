#![allow(dead_code)]
#[link(wasm_import_module = "jsrt")]
unsafe extern "C" {
    pub fn oom(bytes: u32, alignment: u32) -> !;
    pub fn retain(value: u32);
    pub fn release(value: u32);
    pub fn exhausted() -> u32;
    pub fn number(value: i32) -> u32;
    pub fn as_i32(value: u32) -> f64;
    pub fn task_new() -> u32;
    pub fn task_promise(task: u32) -> u32;
    pub fn task_start(task: u32, pointer: u32);
    pub fn task_wake(task: u32);
    pub fn task_cancel(task: u32) -> i32;
    pub fn task_finish(task: u32, result: u32, rejected: i32);
    pub fn subscribe(promise: u32, pointer: u32) -> u32;
    pub fn unsubscribe(wait: u32);
}

// Resolved at build time by wasm-merge, never routed through JS.
#[link(wasm_import_module = "pool")]
unsafe extern "C" {
    pub fn allocate(base: u32, bytes: u32, alignment: u32) -> u32;
    pub fn free(pointer: u32);
    pub fn used() -> u32;
}
