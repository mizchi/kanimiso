import messages from "./error-codes.json";
// Descriptions exist only in debug builds. Release errors link to the reference;
// foreign exceptions retain their original identity, message and code.
export function runtimeError(code, Type = Error) {
  const label = __JSRT_DEBUG_ERRORS__ ? code + ": " + messages[code] : code;
  return Object.assign(
    new Type(
      label +
        " https://github.com/mizchi/taraba/blob/main/docs/error-codes.md#" +
        code.toLowerCase(),
    ),
    { code },
  );
}
