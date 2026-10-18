(module
  (type $unary (func (param i32) (result i32)))
  (func $inc (type $unary) (param i32) (result i32)
    (i32.add (local.get 0) (i32.const 1)))
  (elem declare func $inc)
  (func (export "ref") (result (ref $unary)) (ref.func $inc))
  (func (export "apply") (param (ref null $unary) i32) (result i32)
    (call_ref $unary (local.get 1) (local.get 0))))
