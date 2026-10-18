import messages from "./error-codes.json";
// The release build drops this table and detail formatting via a compile-time
// flag. Codes are stable; external exceptions are never wrapped by this helper.
export function runtimeError(code, Type = Error, detail) {
  const message = __JSRT_DEBUG_ERRORS__
    ? messages[code] + (detail === undefined ? "" : ": " + detail)
    : code;
  return Object.assign(new Type(message), { code });
}
