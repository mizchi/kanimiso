import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";

const bundle = await esbuild.build({
  stdin: {
    contents: `export {createValues} from './src/helper-values.mjs';
    export {stringImports} from './src/strings.mjs';
    export {iteratorImports} from './src/iterator.mjs';
    export {segmenterImports} from './src/segmenter.mjs';
    export {encodingImports} from './src/encoding.mjs';
    export {regexpImports} from './src/regexp.mjs';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  define: { __JSRT_DEBUG_ERRORS__: "false", __TARABA_STRINGS__: "true" },
});
const {
  createValues,
  stringImports,
  iteratorImports,
  segmenterImports,
  encodingImports,
  regexpImports,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
function host() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const values = createValues(() => memory);
  const strings = stringImports(values);
  const put = (s) => {
    const bytes = new TextEncoder().encode(s);
    new Uint8Array(memory.buffer).set(bytes, 32);
    return strings["from-utf8"](32, bytes.length);
  };
  const read = (id) => {
    const size = strings["utf8-len"](id);
    const written = strings["copy-utf8"](id, 1024, size);
    assert.equal(written, size);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      new Uint8Array(memory.buffer, 1024, written),
    );
  };
  return { memory, values, strings, put, read };
}
test("JS strings normalize and stay on the host; copies preserve UTF-8 boundaries and memory growth", () => {
  const { memory, values, strings, put, read } = host();
  const original = put("e\u0301🦀\uFEFF");
  const normalized = strings.normalize(original, 0);
  assert.equal(read(normalized), "é🦀\uFEFF");
  assert.equal(read(strings.normalize(put("Ａ①"), 2)), "A1");
  const copy = values.imports.clone(normalized);
  values.imports.drop(normalized);
  memory.grow(1);
  assert.equal(read(copy), "é🦀\uFEFF");
  const emoji = put("🦀");
  assert.equal(strings["utf16-len"](emoji), 2);
  assert.equal(strings["utf8-len"](emoji), 4);
  new Uint8Array(memory.buffer, 1024, 3).fill(255);
  assert.equal(strings["copy-utf8"](emoji, 1024, 3), 0);
  assert.deepEqual(
    [...new Uint8Array(memory.buffer, 1024, 3)],
    [255, 255, 255],
  );
  assert.equal(strings.equals(emoji, put("🦀")), 1);
  assert.equal(read(strings["to-uppercase"](put("  Straße  "))), "  STRASSE  ");
  assert.equal(read(strings.trim(put("  蟹  "))), "蟹");
});
test("the iterator adapter is lazy, closes on early exit, and yields independently owned items", () => {
  const { values, read } = host();
  const api = iteratorImports(values);
  let pulls = 0,
    closes = 0;
  function* source() {
    try {
      pulls++;
      yield "🦀";
      pulls++;
      yield "蟹";
    } finally {
      closes++;
    }
  }
  const id = values.put(source());
  assert.equal(pulls, 0);
  const item = api.next(id);
  assert.equal(pulls, 1);
  api.close(id);
  assert.equal(closes, 1);
  assert.equal(pulls, 1);
  assert.equal(values.get(id), undefined);
  assert.equal(read(item), "🦀");
  values.imports.drop(item);
  let returns = 0;
  const finite = values.put({
    next: () => ({ done: true }),
    return: () => {
      returns++;
    },
  });
  assert.equal(api.next(finite), 0);
  values.imports.drop(finite); // Normal exhaustion must not invoke return().
  assert.equal(returns, 0);
  const failure = {};
  const throwing = values.put({
    next() {
      throw failure;
    },
  });
  assert.throws(
    () => api.next(throwing),
    (e) => e === failure,
  );
  assert.equal(values.get(throwing), undefined);
  const closeThrow = values.put({
    return() {
      throw failure;
    },
  });
  assert.throws(
    () => api.close(closeThrow),
    (e) => e === failure,
  );
  assert.equal(values.get(closeThrow), undefined);
});
test("segmenters keep source alive and report explicitly UTF-16 positions", () => {
  const { values, strings, put, read } = host();
  const api = segmenterImports(values),
    iter = iteratorImports(values);
  const segmenter = api.new(put("ja"), 0);
  assert.ok(segmenter);
  const input = put("🦀e\u0301👩‍👩‍👧‍👦");
  const iterator = api.segment(segmenter, input);
  values.imports.drop(segmenter);
  values.imports.drop(input);
  const result = [];
  for (let item; (item = iter.next(iterator)) !== 0;) {
    const text = api.text(item);
    result.push([read(text), api.index(item), api["word-like"](item)]);
    values.imports.drop(text);
    values.imports.drop(item);
  }
  values.imports.drop(iterator);
  assert.deepEqual(result, [
    ["🦀", 0, 2],
    ["e\u0301", 2, 2],
    ["👩‍👩‍👧‍👦", 4, 2],
  ]);
  assert.equal(api.new(put("invalid_locale"), 0), 0);
  const points = strings["code-points"](put("🦀a"));
  const first = iter.next(points);
  iter.close(points);
  assert.equal(read(first), "🦀");
});
test("decoding has recoverable invalid-encoding and malformed-input results", () => {
  const { memory, values, put, read } = host();
  const api = encodingImports(values);
  assert.equal(api.new(put("not-an-encoding")), 0);
  const decoder = api.new(put("shift_jis"));
  new Uint8Array(memory.buffer).set([0x82, 0xa0], 32);
  assert.equal(read(api.decode(decoder, 32, 2)), "あ");
  new Uint8Array(memory.buffer)[32] = 0x82;
  assert.equal(api.decode(decoder, 32, 1), 0);
  new Uint8Array(memory.buffer).set([0x82, 0xa0], 32);
  assert.equal(read(api.decode(decoder, 32, 2)), "あ");
  assert.throws(() => api.decode(decoder, 65535, 2), RangeError);
});
test("RegExp consumes JS string roots directly, without copying through guest memory", () => {
  const { values, strings, put, memory } = host();
  const regex = regexpImports(() => memory, values);
  const pattern = put("^é+$"),
    input = strings.normalize(put("e\u0301"), 0);
  const re = regex["compile-string"](pattern);
  values.imports.drop(pattern);
  assert.equal(regex["test-string"](re, input), 1);
  assert.equal(regex["test-string"](re, put("x")), 0);
  assert.equal(regex["compile-string"](put("[")), 0);
  regex.drop(re);
});

// Exercise the native CLI's generated operation blocks independently of the
// full source factories. The same ownership/Unicode cases also run via Wasm.
test("embedded operation closures contain no unused codecs and match source behavior", async () => {
  const { readFileSync } = await import("node:fs");
  const operations = JSON.parse(
    readFileSync("crates/taraba-cli/assets/helper-operations.json"),
  );
  const factory = (module, names) =>
    new Function(
      "v",
      `const a={};${names.map((name) => `{${operations[module][name]}}`).join("")}return a`,
    );
  assert.ok(!operations.strings["utf16-len"].includes("TextEncoder"));
  assert.ok(!operations.strings["utf16-len"].includes("TextDecoder"));
  const { values, put, read } = host();
  const strings = factory("strings", [
    "normalize",
    "to-uppercase",
    "to-lowercase",
    "trim",
    "utf16-len",
  ])(values);
  assert.deepEqual(
    Object.keys(strings).sort(),
    ["normalize", "to-uppercase", "to-lowercase", "trim", "utf16-len"].sort(),
  );
  const id = put("  e\u0301🦀  ");
  assert.equal(
    read(strings["to-uppercase"](strings.normalize(id, 0))),
    "  É🦀  ",
  );
  assert.equal(read(strings["to-lowercase"](put("ΣΣ"))), "σς");
  assert.equal(read(strings.trim(id)), "e\u0301🦀");
  assert.equal(strings["utf16-len"](id), 8);
});

test("helper disposal clears per-instance roots and regex handles", () => {
  const { values, put, memory } = host();
  const root = put("held");
  const regex = regexpImports(() => memory, values);
  const pattern = put("x");
  const id = regex["compile-string"](pattern);
  regex[Symbol.dispose]();
  values[Symbol.dispose]();
  assert.equal(values.get(root), undefined);
  assert.throws(() => regex["test-string"](id, root));
});
