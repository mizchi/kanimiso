import assert from "node:assert/strict";
import test from "node:test";
import { bundleDirectHost } from "./bundle.mjs";
import { bundleHost } from "../jspi-future/bundle.mjs";

test("release excludes snapshot diagnostics and the serial Future host excludes stack machinery", async () => {
  const release = await bundleDirectHost(),
    debug = await bundleDirectHost({ debug: true });
  assert.ok(release.length < debug.length);
  assert.ok(!new TextDecoder().decode(release).includes("snapshot_bytes"));
  assert.ok(new TextDecoder().decode(debug).includes("snapshot_bytes"));
  for (const debug of [false, true]) {
    const serial = await bundleHost({ debug }),
      concurrent = await bundleHost({ debug, concurrent: true });
    assert.ok(
      !new TextDecoder().decode(serial.bytes).includes("taraba:jspi-stack"),
    );
    assert.ok(
      new TextDecoder().decode(concurrent.bytes).includes("taraba:jspi-stack"),
    );
  }
});
