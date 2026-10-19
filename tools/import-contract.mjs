import assert from "node:assert/strict";

// Managed host methods, rt_* exports, __values and task_start/task_wake keep
// their names. Only private Wasm function imports and private record fields move.
export const importNames = [
  "__root",
  "__take",
  "retain",
  "release",
  "oom",
  "exhausted",
  "number",
  "as_i32",
  "task_new",
  "task_promise",
  "task_cancel",
  "task_finish",
  "subscribe",
  "unsubscribe",
];
export const mangleProps = `^(${[...importNames, "state", "ptr", "queued", "value", "rejected"].join("|")})$`;

// This operates on our hashed, comment-free expression bodies, before WAT
// assembly. Match a whole expression so trailing function/module ')' survive.
export function stripUsedCounter(wat) {
  const pattern =
    /\(global \$used\b|\(global\.set \$used\b|\(func \(export "used"\)/g;
  let result = "",
    end = 0,
    match;
  while ((match = pattern.exec(wat))) {
    let depth = 0,
      pos = match.index;
    do {
      assert.ok(pos < wat.length, "unterminated counter expression");
      const c = wat[pos++];
      if (c === "(") depth++;
      if (c === ")") depth--;
    } while (depth);
    result += wat.slice(end, match.index);
    if (match[0].startsWith("(func"))
      result += '(func (export "used") (result i32) (i32.const 0))';
    end = pos;
    pattern.lastIndex = pos;
  }
  return (result + wat.slice(end)).replace(/[ \t]+$/gm, "");
}

// Patch just the import section. Function/table indices, code, GC types, data,
// exports and custom sections remain byte-identical. Fail closed on unsupported
// import kinds; the runtime currently imports functions and one externref table.
export function renameImports(input, names) {
  const bytes = Buffer.from(input);
  assert.ok(
    bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])),
  );
  for (const value of Object.values(names))
    assert.ok(typeof value === "string" && value.length);
  const leb = (n) => {
    const b = [];
    do {
      const x = n & 127;
      n = Math.floor(n / 128);
      b.push(x | (n ? 128 : 0));
    } while (n);
    return Buffer.from(b);
  };
  const string = (s) => {
    const b = Buffer.from(s);
    return Buffer.concat([leb(b.length), b]);
  };
  let pos = 8;
  const uint = () => {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      assert.ok(pos < bytes.length);
      const b = bytes[pos++];
      n += (b & 127) * 2 ** (i * 7);
      assert.ok(n <= 0xffffffff);
      if (!(b & 128)) return n;
    }
    throw Error("invalid u32 LEB");
  };
  const readString = () => {
    const size = uint(),
      start = pos;
    pos += size;
    assert.ok(pos <= bytes.length);
    return bytes.subarray(start, pos).toString("utf8");
  };
  const sections = [bytes.subarray(0, 8)];
  while (pos < bytes.length) {
    const start = pos,
      id = bytes[pos++],
      size = uint(),
      end = pos + size;
    assert.ok(end <= bytes.length);
    if (id !== 2) {
      sections.push(bytes.subarray(start, end));
      pos = end;
      continue;
    }
    const count = uint(),
      parts = [leb(count)];
    for (let i = 0; i < count; i++) {
      const module = readString(),
        name = readString(),
        descriptor = pos,
        kind = bytes[pos++];
      if (kind === 0) uint();
      else if (kind === 1) {
        assert.equal(bytes[pos++], 0x6f, "expected private externref table");
        const flags = uint();
        assert.ok(flags === 0 || flags === 1);
        uint();
        if (flags === 1) uint();
      } else throw Error(`unsupported import kind ${kind}`);
      assert.ok(pos <= end);
      const renamed =
        module === "jsrt" && kind === 0 ? (names[name] ?? name) : name;
      parts.push(
        string(module),
        string(renamed),
        bytes.subarray(descriptor, pos),
      );
    }
    assert.equal(pos, end);
    const payload = Buffer.concat(parts);
    sections.push(Buffer.from([2]), leb(payload.length), payload);
  }
  return Buffer.concat(sections);
}
