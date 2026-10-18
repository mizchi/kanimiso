;; Freed Future bytes hold their next pointer only after successful Rust Drop.
;; Trusted private ABI: one instance/base; matching, unique frees only.
(module
  (import "app" "memory" (memory 4 16))
  (global $next (mut i32) (i32.const 0))
  (global $head (mut i32) (i32.const 0))
  (global $used (mut i32) (i32.const 0))
  (func (export "used") (result i32) (global.get $used))
  (func (export "allocate") (param $base i32) (param $bytes i32) (param $align i32) (result i32)
    (local $ptr i32)
    (if (i32.or
          (i32.or (i32.eqz (local.get $bytes)) (i32.gt_u (local.get $bytes) (i32.const 128)))
          (i32.or (i32.eqz (local.get $align))
            (i32.or (i32.gt_u (local.get $align) (i32.const 64))
              (i32.and (local.get $align) (i32.sub (local.get $align) (i32.const 1))))))
      (then (return (i32.const 0))))

    (if (global.get $head)
      (then
        (local.set $ptr (global.get $head))
        (global.set $head (i32.load (local.get $ptr))))
      (else
        (if (i32.ge_u (global.get $next) (i32.const 1024)) (then (return (i32.const 0))))
        (local.set $ptr (i32.add (local.get $base) (i32.shl (global.get $next) (i32.const 7))))
        (global.set $next (i32.add (global.get $next) (i32.const 1)))))
    (global.set $used (i32.add (global.get $used) (i32.const 1)))
    (local.get $ptr))
  (func (export "free") (param $ptr i32)
    (i32.store (local.get $ptr) (global.get $head))
    (global.set $head (local.get $ptr))
    (global.set $used (i32.sub (global.get $used) (i32.const 1))))
)
