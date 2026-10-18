(module
  (global $code (import "s" "RT01") externref)
  (func $concat (import "wasm:js-string" "concat")
    (param externref externref) (result (ref extern)))
  (func (export "code") (result externref) (global.get $code))
  (func (export "concat") (param externref externref) (result (ref extern))
    (call $concat (local.get 0) (local.get 1))))
