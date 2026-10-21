import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
const root = resolve(".cache/browser");
createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/pending") {
    req.on("close", () => {});
    return;
  }
  const path = resolve(
    root,
    "." + (pathname === "/" ? "/index.html" : pathname),
  );
  if (!path.startsWith(root + "/")) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!statSync(path).isFile()) throw Error();
    res.setHeader(
      "content-type",
      {
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".html": "text/html",
      }[extname(path)] || "application/octet-stream",
    );
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404).end();
  }
}).listen(4179, "127.0.0.1");
