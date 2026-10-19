import assert from "node:assert/strict";
import test from "node:test";
import { wasmSections } from "../tools/wasm-sections.mjs";

const header = [0, 97, 115, 109, 1, 0, 0, 0];
test("custom metadata and initialized data are distinct and account for every byte", () => {
  const wasm = Buffer.from([
    ...header,
    0,
    5,
    3,
    102,
    111,
    111,
    42, // custom "foo", one payload byte
    11,
    3,
    1,
    0,
    0, // data section (opaque to this size inspector)
  ]);
  const sections = wasmSections(wasm);
  assert.deepEqual(
    sections.map(({ id, name, bytes }) => ({ id, name, bytes })),
    [
      { id: 0, name: "foo", bytes: 7 },
      { id: 11, name: "data", bytes: 5 },
    ],
  );
  assert.equal(8 + sections.reduce((sum, s) => sum + s.bytes, 0), wasm.length);
  assert.equal(sections[1].payload_bytes, 3);
});

test("multi-byte section lengths are counted including the encoded header", () => {
  const wasm = Buffer.from([...header, 0, 129, 1, 0, ...Array(128).fill(0)]);
  const [section] = wasmSections(wasm);
  assert.equal(section.bytes, 132);
  assert.equal(section.payload_bytes, 129);
  assert.equal(section.name, "");
});

test("malformed headers and lengths fail instead of undercounting bytes", () => {
  for (const bytes of [
    [],
    [...header, 0],
    [...header, 0, 128],
    [...header, 0, 255, 255, 255, 255, 16],
    [...header, 0, 2, 3, 65],
    [...header, 11, 3, 0],
  ])
    assert.throws(() => wasmSections(Buffer.from(bytes)));
});
