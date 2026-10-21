import { test, expect } from "./fixtures.mjs";
for (const profile of ["future", "jspi"]) {
  test(`${profile} ESM facade runs in a module Worker`, async ({ page }) => {
    const result = await page.evaluate(async (profile) => {
      const source = `
        import {createHost} from ${JSON.stringify(location.origin + "/" + profile + "/index.js")};
        self.onmessage=async()=>{
          let host;
          try {
            host=createHost({bindings:${profile === "future" ? "{exchange:async v=>v}" : "{add:async(a,b)=>a+b}"}});
            host.attach((await WebAssembly.instantiateStreaming(fetch(${JSON.stringify(location.origin + "/" + profile + "/app.wasm")}),host.imports)).instance.exports);
            const value=${profile === "future" ? `await host.run({id:18446744073709551615n,label:'worker 🦀',payload:new Uint8Array([0,128,255])})` : `await host.run(20,21)`};
            host.dispose();
            self.postMessage({value,stats:host.stats()});
          }catch(e){host?.dispose();self.postMessage({error:String(e)});}
        };
      `;
      const url = URL.createObjectURL(
          new Blob([source], { type: "text/javascript" }),
        ),
        worker = new Worker(url, { type: "module" });
      try {
        return await new Promise((resolve, reject) => {
          worker.onmessage = (e) => resolve(e.data);
          worker.onerror = (e) => reject(new Error(e.message));
          worker.postMessage(null);
        });
      } finally {
        worker.terminate();
        URL.revokeObjectURL(url);
      }
    }, profile);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(
      profile === "future"
        ? {
            id: 18446744073709551615n,
            label: "worker 🦀",
            payload: new Uint8Array([0, 128, 255]),
          }
        : 42,
    );
    expect(result.stats.dead).toBe(true);
    if (profile === "future") {
      expect(
        result.stats.live_values +
          result.stats.live_tasks +
          result.stats.live_waits,
      ).toBe(0);
    } else {
      expect(result.stats.queued).toBe(0);
      expect(result.stats.calls).toBe(1);
      expect(result.stats.completions).toBe(1);
    }
  });
}
