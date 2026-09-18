import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const root = fileURLToPath(new URL("../", import.meta.url));
const images = new Map(["doc-review", "doc-review-feedback", "doc-review-changes", "doc-review-social"]
  .map((name) => [`/assets/${name}.png`, path.join(root, "assets", `${name}.png`)]));
const documents = new Map([["/", "README.md"], ["/usage", path.join("docs", "usage.md")]]);
const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, "http://localhost").pathname;
  if (req.method !== "GET" || (!images.has(route) && !documents.has(route) && route !== "/social")) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const headers = {
      "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    };
    if (images.has(route)) {
      const image = await readFile(images.get(route));
      res.writeHead(200, { ...headers, "content-type": "image/png" }).end(image);
      return;
    }
    const content = route === "/social"
      ? '<h1>Social-sharing cover</h1><p>1280 &times; 640. Prepared locally; not uploaded to GitHub.</p><img src="/assets/doc-review-social.png" alt="Doc Review social cover">'
      : marked.parse((await readFile(path.join(root, documents.get(route)), "utf8"))
        .replaceAll("https://raw.githubusercontent.com/erdemtuna/doc-review/main/assets/", "/assets/")
        .replaceAll("../assets/", "/assets/"));
    res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Doc Review - local media preview</title><style>
  *{box-sizing:border-box}body{margin:0;color:#1f2328;background:#f6f8fa;font:16px/1.6 system-ui,sans-serif}
  nav{padding:16px 24px;border-bottom:1px solid #d1d9e0;background:white;font-size:14px}nav a{margin-right:20px}
  article{max-width:${route === "/social" ? "1360" : "960"}px;margin:24px auto;padding:32px;background:white;border:1px solid #d1d9e0;border-radius:8px}
  h1,h2,h3{line-height:1.25}h1,h2{padding-bottom:10px;border-bottom:1px solid #d1d9e0}h2{margin-top:32px}
  img{display:block;max-width:100%;height:auto;border:1px solid #d1d9e0;border-radius:6px}a{color:#0969da}
  pre{padding:16px;background:#f6f8fa;overflow:auto;border-radius:6px}code{font-size:13px}
  li{margin:8px 0}table{border-collapse:collapse;display:block;overflow:auto}th,td{padding:8px 12px;border:1px solid #d1d9e0}
  @media(max-width:650px){article{margin:0;padding:20px;border:0}}
</style></head><body>
<nav><strong>Local media preview</strong> &nbsp; <a href="/">README</a><a href="/usage">Usage guide</a><a href="/social">Social cover</a></nav>
<article>${content}</article></body></html>`);
  } catch (error) {
    console.error("Media preview failed:", error);
    res.writeHead(500).end("Could not load preview. See the server log.");
  }
});
server.listen(0, "127.0.0.1", () => {
  console.log(`README preview: http://127.0.0.1:${server.address().port}/`);
  console.log(`Social cover: http://127.0.0.1:${server.address().port}/social`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close());
}
