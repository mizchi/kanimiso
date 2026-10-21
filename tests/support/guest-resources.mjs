// The same guest is exercised in Node, installed npm consumers, and browsers.
export const guestResourceWit = `package test:guest-resources;
interface counters {
  resource counter {
    constructor(start:u32);
    add:func(value:u32)->u32;
    read:func()->u32;
    wait:async func()->u32;
    crash:func();
  }
  resource token { constructor(); read:func()->u32; }
  consume:func(value:own<counter>)->u32;
  hold:async func(value:borrow<counter>)->u32;
  drops:func()->u32;
}
world app { import notify:func(phase:u32); import tick:async func()->u32; export api:counters; }`;
export const guestResourceRust = `
include!(concat!(env!("OUT_DIR"),"/bindings.rs"));
bindings!(App);
use core::cell::Cell;
use core::sync::atomic::{AtomicU32,Ordering::Relaxed};
static DROPS:AtomicU32=AtomicU32::new(0);
pub struct App;
// Holding a JS root exercises destructor ordering during host shutdown.
pub struct Counter { value:Cell<u32>, _root:taraba::JsValue, _last:AfterDrop }
pub struct Token;
struct AfterDrop;
impl Drop for AfterDrop {fn drop(&mut self){notify(1);}}
impl Drop for Counter {fn drop(&mut self){DROPS.fetch_add(1,Relaxed);notify(0);}}
impl exports::api::Guest for App {
  type Counter=Counter;
  type Token=Token;
  fn consume(value:CountersCounter)->u32{value.value.get()}
  async fn hold(value:Borrowed<CountersCounter>)->HostResult<u32>{tick().await?;Ok(value.value.get())}
  fn drops()->u32{DROPS.load(Relaxed)}
}
impl exports::api::GuestCounter for Counter {
  fn new(start:u32)->Self{Self{value:Cell::new(start),_root:taraba::JsValue::from_i32(start as i32),_last:AfterDrop}}
  fn add(&self,value:u32)->u32{let n=self.value.get().wrapping_add(value);self.value.set(n);n}
  fn read(&self)->u32{self.value.get()}
  async fn wait(&self)->HostResult<u32>{tick().await?;Ok(self.value.get())}
  fn crash(&self){core::arch::wasm32::unreachable()}
}
impl exports::api::GuestToken for Token {
  fn new()->Self{Self}
  fn read(&self)->u32{77}
}
export!(App);
`;
export const syncResourceWit = `package test:sync-resource;
interface counters {
  resource counter { constructor(start:u32); add:func(value:u32)->u32; read:func()->u32; }
  consume:func(value:own<counter>)->u32;
}
world app { export api:counters; }`;
export const syncResourceRust = `
include!(concat!(env!("OUT_DIR"),"/bindings.rs"));bindings!(App);
use core::cell::Cell;
pub struct App; pub struct Counter(Cell<u32>);
impl exports::api::Guest for App {
  type Counter=Counter;
  fn consume(value:CountersCounter)->u32{value.0.get()}
}
impl exports::api::GuestCounter for Counter {
  fn new(start:u32)->Self{Self(Cell::new(start))}
  fn add(&self,value:u32)->u32{let n=self.0.get().wrapping_add(value);self.0.set(n);n}
  fn read(&self)->u32{self.0.get()}
}
export!(App);`;
