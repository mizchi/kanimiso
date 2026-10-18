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
    modes
      .map(
        (m) =>
          `\nimport jspi_${m} from "../../dist/examples/jspi-${m}-minimal.wasm";`,
      )
      .join("\n") +
    `
import {createHost as release} from "../../dist/release.mjs";
import {createHost as debug} from "../../dist/debug.mjs";
import {instantiate as instantiateJspi} from "../../dist/jspi.mjs";
import {verifyWit} from "../../tests/support/wit-contract.mjs";
import {asyncCases} from "../../tests/support/async-contract.mjs";
import {workerService} from "../../tests/support/worker.mjs";
const jspiModules={no_std:jspi_no_std,std:jspi_std};
const handlers={release:workerService({no_std,std},release),debug:workerService({no_std,std},debug)};
export default {async fetch(request) {
 const url=new URL(request.url),[variant,mode]=url.pathname.slice(1).split("/");
 if(variant==="health") return new Response("ok");
 if(variant==="jspi") {
   const capabilities={promising:typeof WebAssembly.promising,suspending:typeof WebAssembly.Suspending};
   if(capabilities.promising!=="function"||capabilities.suspending!=="function") return Response.json({mode,eligible:false,capabilities,reason:"JSPI is unavailable in this local workerd"});
   try {
     const result=await verifyWit(async add=>{const h=await instantiateJspi(jspiModules[mode],{bindings:{add}});return(...a)=>h.promise("run",...a)},[1,16,128,1024].flatMap(asyncCases));
     return Response.json({mode,eligible:true,...result});
   } catch(error) {return Response.json({mode,eligible:true,error:String(error)},{status:500});}
 }
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
  const jspi = [];
  for (const mode of modes) {
    const response = await fetch(`http://127.0.0.1:${port}/jspi/${mode}`, {
      signal: AbortSignal.timeout(30000),
    });
    const entry = await response.json();
    assert.equal(response.status, 200, JSON.stringify(entry));
    if (entry.eligible) {
      assert.equal(entry.all_passed, true);
      assert.equal(entry.tasks, 3507);
    }
    jspi.push(entry);
    console.log(
      `jspi/${mode}: ${entry.eligible ? "local workerd passed" : "JSPI unavailable in local workerd"}`,
    );
  }
  writeFileSync(
    ".cache/workers.json",
    JSON.stringify(
      {
        environment:
          "local workerd; no production deployment; nodejs_compat for test assertions",
        entries,
        jspi,
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
