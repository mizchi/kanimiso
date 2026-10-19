import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
const dir = ".cache/workers";
mkdirSync(dir, { recursive: true });
const modes = ["no_std", "std"];
const concurrent = process.argv.includes("--jspi-concurrent");
const future = concurrent || process.argv.includes("--jspi-future");
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
    (future
      ? modes
          .map(
            (m) =>
              `\nimport future_${m} from "../jspi-future-experiment/adapter-${m}/core/app.wasm";\nimport probes_${m} from "../jspi-future-experiment/adapter-${m}/probes/app.wasm";\nimport bounded_${m} from "../jspi-future-experiment/bounded-${m}/core/app.wasm";\nimport boundedProbes_${m} from "../jspi-future-experiment/bounded-${m}/probes/app.wasm";\nimport heapProbes_${m} from "../jspi-future-experiment/bounded-${m}/heap-probes/app.wasm";`,
          )
          .join("\n") +
        `\nimport {instantiate as instantiateFuture} from "../jspi-future-experiment/bounded-no_std/host.mjs";\nimport {instantiate as instantiateFutureDebug} from "../jspi-future-experiment/bounded-no_std/host-debug.mjs";\nimport {verifyDriver} from "../../experiments/jspi-future/verify.mjs";\nconst futureModules={no_std:future_no_std,std:future_std},futureProbes={no_std:probes_no_std,std:probes_std};const boundedModules={no_std:bounded_no_std,std:bounded_std},boundedProbes={no_std:boundedProbes_no_std,std:boundedProbes_std},heapProbes={no_std:heapProbes_no_std,std:heapProbes_std};\n`
      : "") +
    (concurrent
      ? modes
          .map(
            (
              m,
            ) => `\nimport parallel_${m} from "../jspi-concurrent/jspi-concurrent-${m}/core/app.wasm";
import parallelProbes_${m} from "../jspi-concurrent/jspi-concurrent-${m}/probes/app.wasm";
import parallelBounded_${m} from "../jspi-concurrent/bounded-concurrent-${m}/core/app.wasm";
import parallelBoundedProbes_${m} from "../jspi-concurrent/bounded-concurrent-${m}/probes/app.wasm";
import parallelBoundedHeap_${m} from "../jspi-concurrent/bounded-concurrent-${m}/heap-probes/app.wasm";`,
          )
          .join("\n") +
        `
import {instantiate as parallelRelease} from "../jspi-concurrent/jspi-concurrent-no_std/host.mjs";
import {instantiate as parallelDebug} from "../jspi-concurrent/jspi-concurrent-no_std/host-debug.mjs";
import {instantiate as parallelBoundedRelease} from "../jspi-concurrent/bounded-concurrent-no_std/host.mjs";
import {instantiate as parallelBoundedDebug} from "../jspi-concurrent/bounded-concurrent-no_std/host-debug.mjs";
import {verifyConcurrent,verifyFutureOverlap} from "../../experiments/jspi-concurrent/verify.mjs";
import {verifyScheduling} from "../../tests/support/scheduling.mjs";
const parallelModules={no_std:parallel_no_std,std:parallel_std}, parallelProbes={no_std:parallelProbes_no_std,std:parallelProbes_std};
const parallelBoundedModules={no_std:parallelBounded_no_std,std:parallelBounded_std}, parallelBoundedProbes={no_std:parallelBoundedProbes_no_std,std:parallelBoundedProbes_std}, parallelBoundedHeap={no_std:parallelBoundedHeap_no_std,std:parallelBoundedHeap_std};
`
      : "") +
    `
import {createHost as release} from "../../dist/release.mjs";
import {createHost as debug} from "../../dist/debug.mjs";
import {createHost as createJspiHost} from "../../dist/jspi.mjs";
import {createLoader} from "../../tests/support/core-host.mjs";
const instantiateJspi=createLoader(createJspiHost);
import {verifyWit} from "../../tests/support/wit-contract.mjs";
import {asyncCases} from "../../tests/support/async-contract.mjs";
import {workerService} from "../../tests/support/worker.mjs";
const jspiModules={no_std:jspi_no_std,std:jspi_std};
const handlers={release:workerService({no_std,std},release),debug:workerService({no_std,std},debug)};
export default {async fetch(request) {
 const url=new URL(request.url),[variant,mode,build="release"]=url.pathname.slice(1).split("/");
 if(variant==="health") return new Response("ok");
 ${
   future
     ? `if(variant==="jspi-future"||variant==="jspi-bounded") {
   try {
     const bounded=variant==="jspi-bounded",debug=build==="debug",instantiate=debug?instantiateFutureDebug:instantiateFuture;
     const common=await verifyWit(async add=>{const h=await instantiate((bounded?boundedModules:futureModules)[mode],{bindings:{add}});return(...a)=>h.promise("run",...a)},[1,16,128,1024].flatMap(asyncCases));
     const probes=await verifyDriver(instantiate,(bounded?boundedProbes:futureProbes)[mode],{unordered:!bounded,bounded,debug});
     const heap_probes=bounded?await verifyDriver(instantiate,heapProbes[mode],{unordered:true,bounded:true,debug}):null;
     return Response.json({mode,build,bounded,common,probes,heap_probes,all_passed:true});
   }catch(error){return Response.json({mode,error:String(error)},{status:500})}
 }`
     : ""
 }
 ${
   concurrent
     ? `if(variant==="jspi-concurrent"||variant==="jspi-bounded-concurrent") {
  try {
    const bounded=variant==="jspi-bounded-concurrent",debug=build==="debug";
    const instantiate=bounded?(debug?parallelBoundedDebug:parallelBoundedRelease):(debug?parallelDebug:parallelRelease);
    const module=(bounded?parallelBoundedModules:parallelModules)[mode],probe=(bounded?parallelBoundedProbes:parallelProbes)[mode];
    const factory=async add=>{const h=await instantiate(module,{bindings:{add}});return(...a)=>h.promise("run",...a);};
    const common=await verifyWit(factory,[1,16,128,1024].flatMap(asyncCases));
    const scheduling=await verifyScheduling(factory,{serialized:false});
    const probes=bounded?await verifyDriver(instantiate,probe,{bounded:true,unordered:false,debug,concurrent:true}):await verifyConcurrent(instantiate,probe);
    const heap_probes=bounded?await verifyDriver(instantiate,parallelBoundedHeap[mode],{bounded:true,unordered:true,debug,concurrent:true}):null;
    const overlap=bounded?await verifyFutureOverlap(instantiate,parallelBoundedHeap[mode]):null;
    return Response.json({mode,build,bounded,common,scheduling,probes,heap_probes,overlap,all_passed:true});
  }catch(error){return Response.json({mode,error:String(error)},{status:500})}
 }`
     : ""
 }
 if(variant==="jspi") {
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
    name: "taraba-smoke",
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
    assert.equal(entry.eligible, true);
    assert.equal(entry.all_passed, true);
    assert.equal(entry.tasks, 3507);
    jspi.push(entry);
    console.log(`jspi/${mode}: local workerd passed`);
  }
  const jspi_future = [];
  if (future)
    for (const variant of ["jspi-future", "jspi-bounded"])
      for (const mode of modes)
        for (const build of ["release", "debug"]) {
          const response = await fetch(
            `http://127.0.0.1:${port}/${variant}/${mode}/${build}`,
            { signal: AbortSignal.timeout(30000) },
          );
          const entry = await response.json();
          assert.equal(response.status, 200, JSON.stringify(entry));
          assert.equal(entry.all_passed, true);
          assert.equal(entry.common.tasks, 3507);
          assert.equal(entry.probes.all_passed, true);
          assert.equal(entry.probes.diagnostics, build === "debug");
          if (variant === "jspi-bounded") {
            assert.equal(entry.probes.fixed_capacity, 16);
            assert.equal(
              entry.heap_probes.futures_unordered_child_wakers,
              true,
            );
          }
          jspi_future.push({ variant, ...entry });
          console.log(`${variant}/${mode}/${build}: local workerd passed`);
        }
  const jspi_concurrent = [];
  if (concurrent)
    for (const variant of ["jspi-concurrent", "jspi-bounded-concurrent"])
      for (const mode of modes)
        for (const build of ["release", "debug"]) {
          const response = await fetch(
            `http://127.0.0.1:${port}/${variant}/${mode}/${build}`,
            { signal: AbortSignal.timeout(30000) },
          );
          const entry = await response.json();
          assert.equal(response.status, 200, JSON.stringify(entry));
          assert.equal(entry.all_passed, true);
          assert.equal(entry.common.tasks, 3507);
          assert.deepEqual(entry.scheduling.completed_while_a_blocked, ["B"]);
          assert.equal(entry.probes.all_passed, true);
          jspi_concurrent.push({ variant, ...entry });
          console.log(`${variant}/${mode}/${build}: local workerd passed`);
        }
  writeFileSync(
    ".cache/workers.json",
    JSON.stringify(
      {
        environment:
          "local workerd; no production deployment; nodejs_compat for test assertions",
        entries,
        jspi,
        ...(future ? { jspi_future } : {}),
        ...(concurrent ? { jspi_concurrent } : {}),
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
