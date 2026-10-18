let binding;
export function setBinding(add) {
  binding = add;
}
export function add(a, b) {
  return binding(a, b);
}
