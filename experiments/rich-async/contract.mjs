import assert from "node:assert/strict";
export function input(id, size = 32, label = "注文 🍣\uFEFF\0") {
  return {
    id: id >>> 0,
    label,
    payload: Uint8Array.from({ length: size }, (_, i) => (i * 37 + id) & 255),
  };
}
export function transform(value) {
  if (value.label.startsWith("denied"))
    return { tag: "err", val: "host-denied" };
  return {
    tag: "ok",
    val: {
      ...value,
      label: value.label + "/js",
      payload: Uint8Array.from(value.payload, (b) => b ^ 0x5a),
    },
  };
}
export function expected(packet) {
  let value = structuredClone(packet);
  if (value.id === 0) return { tag: "err", val: "invalid-id" };
  for (let step = 0; step < 2; step++) {
    value.label += "/rust";
    value.payload = Uint8Array.from(
      value.payload,
      (b, i) => (b + i + step) & 255,
    );
    const result = transform(value);
    if (result.tag === "err") return result;
    value = result.val;
    value.id = (value.id + 1) >>> 0;
  }
  return { tag: "ok", val: value };
}
export async function verify(factory) {
  let calls = 0;
  const api = await factory(async (value) => {
    calls++;
    await Promise.resolve();
    return transform(value);
  });
  const samples = [
    input(0),
    input(1, 0, ""),
    input(0xffffffff, 1),
    input(0x80000000, 257),
    input(42, 65536),
    input(1, 32, "denied"),
  ];
  for (let i = 0; i < 64; i++)
    samples.push(input(i + 1, i * 17, i % 2 ? "abc" : "日本語 🦀"));
  for (const sample of samples) {
    const before = structuredClone(sample);
    assert.deepEqual(await api.run(sample), expected(sample));
    assert.deepEqual(sample, before, "FFI input must be copied");
  }
  for (const concurrency of [1, 16, 128]) {
    const values = Array.from({ length: concurrency }, (_, i) =>
      input(i + 1, 1024),
    );
    assert.deepEqual(
      await Promise.all(values.map(api.run)),
      values.map(expected),
    );
  }
  assert.deepEqual(
    await api.run(input(17)),
    expected(input(17)),
    "domain error must allow reuse",
  );
  return {
    cases: samples.length + 1 + 1 + 16 + 128,
    host_calls: calls,
    unicode_bytes_result_concurrent: true,
  };
}
