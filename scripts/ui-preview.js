import http from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const recovery = process.argv.includes("--recovery");
const output = path.join(root, recovery ? ".recovery-preview" : ".ui-preview");
const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = portArgument ? Number(portArgument.slice(7)) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid preview port.");
await build({
  configFile: path.join(root, "vite.preview.config.ts"),
  ...(recovery ? {
    root: path.join(root, "src", "ui", "recovery-preview"),
    build: { outDir: output },
  } : {}),
});

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
]);
const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  try {
    const url = new URL(request.url, "http://localhost");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400).end("Malformed path");
      return;
    }
    const file = path.resolve(output, `.${pathname === "/" ? "/index.html" : pathname}`);
    const relative = path.relative(output, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !types.has(path.extname(file))) {
      response.writeHead(404).end("Not found");
      return;
    }
    const metadata = await stat(file);
    if (!metadata.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    const content = await readFile(file);
    response.writeHead(200, {
      "content-type": types.get(path.extname(file)),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    }).end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      response.writeHead(404).end("Not found");
      return;
    }
    console.error("[ui-preview] Request failed", error);
    response.writeHead(500).end("Preview request failed");
  }
});
server.on("error", (error) => {
  console.error("[ui-preview] Server failed", error);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview address unavailable.");
  console.log(`${recovery ? "G3 recovery state" : "G1 component"} preview: http://127.0.0.1:${address.port}`);
  console.log("Built fixture only, separate from production. Stop before rebuilding this preview.");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
