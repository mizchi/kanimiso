import messages from "./error-codes.json" with { type: "json" };

// Only our own errors use this helper. Preserve foreign rejection/trap identity.
export function runtimeError(id, Type = Error) {
  const code = "JF" + id;
  const error = new Type(
    __JF_DEBUG__
      ? code + ": " + (messages[id] ?? "unknown runtime error")
      : code,
  );
  error.code = code;
  return error;
}
