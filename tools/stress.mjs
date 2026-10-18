import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fuzz } from "../tests/support/fuzz.mjs";
import { createHost } from "../dist/release.mjs";
const seconds = Number(process.argv[2] ?? 60);
assert.ok(
  Number.isFinite(seconds) && seconds >= 60,
  "stress duration must be at least 60 seconds",
);
const modules = ["no_std", "std"].map((mode) => ({
  mode,
  bytes: readFileSync(`dist/examples/${mode}-probes.wasm`),
}));
const start = performance.now(),
  runs = [];
let round = 0;
do {
  let expected;
  const seed = (42 + round * 2654435761) >>> 0;
  for (const { mode, bytes } of modules) {
    const result = await fuzz(bytes, {
      factory: createHost,
      seed,
      steps: 10000,
      fatalAtEnd: true,
    });
    const { memory_bytes, ...observables } = result;
    assert.equal(memory_bytes, 262144);
    if (expected) assert.deepEqual(observables, expected);
    else expected = observables;
    runs.push({ mode, ...result });
  }
  round++;
  if (round % 50 === 0)
    console.log(`stress: ${round} seeds / ${runs.length * 10000} steps`);
} while (performance.now() - start < seconds * 1000);
const report = {
  duration_s: (performance.now() - start) / 1000,
  rounds: round,
  steps: runs.length * 10000,
  runs,
  all_passed: true,
};
writeFileSync(".cache/stress.json", JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    duration_s: report.duration_s,
    rounds: round,
    steps: report.steps,
    all_passed: true,
  }),
);
