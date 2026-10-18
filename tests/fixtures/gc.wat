(module
  (type $pair (struct (field i32) (field externref)))
  (func (export "make") (param i32 externref) (result (ref $pair))
    (struct.new $pair (local.get 0) (local.get 1)))
  (func (export "value") (param (ref $pair)) (result externref)
    (struct.get $pair 1 (local.get 0))))
