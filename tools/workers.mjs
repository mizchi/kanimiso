import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
const dir = ".cache/workers";
mkdirSync(dir, { recursive: true });
const modes = ["no_std", "std"];
writeFileSync(
  `${dir}/entry.mjs`,
  modes
    .map((m) => `import ${m} from "../../dist/examples/${m}-full.wasm";`)
    .join("\n") +
    `
import {createHost as release} from "../../dist/release.mjs";
import {createHost as debug} from "../../dist/debug.mjs";
import {workerService} from "../../tests/support/worker.mjs";
const handlers={release:workerService({no_std,std},release),debug:workerService({no_std,std},debug)};
export default {fetch(request) {
 const url=new URL(request.url),[variant,mode]=url.pathname.slice(1).split("/");
 if(variant==="health") return new Response("ok");
 if(!handlers[variant]) return new Response("not found",{status:404});
 url.pathname="/"+mode;
 return handlers[variant].fetch(new Request(url,request));
}};
`,
);
writeFileSync(
  `${dir}/wrangler.json`,
  JSON.stringify({
    name: "kanimiso-smoke",
    main: "entry.mjs",
    compatibility_date: "2026-10-12",
    compatibility_flags: ["nodejs_compat"],
    send_metrics: false,
  }),
);
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await new Promise((r) => server.close(r));
let log = "",
  exited = false;
const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    `${dir}/wrangler.json`,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--show-interactive-dev-session=false",
  ],
  {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
child.stdout.on("data", (b) => {
  log += b;
});
child.stderr.on("data", (b) => {
  log += b;
});
child.on("exit", () => {
  exited = true;
});
try {
  let ready = false;
  for (let i = 0; i < 200 && !exited; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await setTimeout(100);
  }
  assert.ok(ready, log.slice(-6000));
  const entries = [];
  for (const variant of ["release", "debug"])
    for (const mode of modes) {
      const response = await fetch(
          `http://127.0.0.1:${port}/${variant}/${mode}`,
          { signal: AbortSignal.timeout(30000) },
        ),
        r = await response.json();
      assert.equal(response.status, 200, JSON.stringify(r));
      assert.equal(r.all_passed, true);
      assert.equal(r.tasks, 3507);
      assert.equal(r.extra_checks, 20);
      assert.equal(
        r.diagnostics.live_values +
          r.diagnostics.live_waits +
          r.diagnostics.live_tasks,
        0,
      );
      entries.push({ variant, ...r });
      console.log(`${variant}/${mode}: local workerd passed`);
    }
  writeFileSync(
    ".cache/workers.json",
    JSON.stringify(
      {
        environment:
          "local workerd; no production deployment; nodejs_compat for test assertions",
        entries,
        all_passed: true,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  writeFileSync(`${dir}/log.txt`, log);
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}
