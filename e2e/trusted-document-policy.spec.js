import { test, expect } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { transformInteractiveHtml } from "../lib/document-execution.js";
import { interactiveFileCsp, framePolicy, TRUSTED_SDK_MODULE_PATHS } from "../lib/frame-policy.js";
import { injectSdk } from "../lib/html-transform.js";

test("automatic self-contained scripts and handlers run with real SDK but arbitrary dependencies remain blocked", async ({ page }) => {
  const requests = [];
  let origin;
  const source = `<!doctype html><html><head>
    <script src="/authored-external.js"></script>
    <script type=module>window.inlineModule = true;</script>
    <script type=module>import "/static-import.js"; window.staticImport = true;</script>
    <script>
      window.inlineClassic = true;
      window.blocked = {};
      import("/dynamic-import.js").catch(() => window.blocked.dynamic = true);
      import("data:text/javascript,window.dataImport=true").catch(() => window.blocked.data = true);
      try { new Worker("/worker.js"); } catch { window.blocked.worker = true; }
      const external = document.createElement("script");
      external.src = "/created-script.js";
      document.head.append(external);
      const nonceExternal = document.createElement("script");
      nonceExternal.nonce = document.querySelector("[data-eh-bootstrap]").nonce;
      nonceExternal.src = "/nonce-script.js";
      document.head.append(nonceExternal);
      try { window.stolen = parent.parentApiToken; } catch { window.blocked.parent = true; }
    </script></head><body>
      <button id=tab onclick="document.querySelector('#panel').textContent='Product'">Product tab</button>
      <p id=panel>Overview</p>
      <iframe srcdoc="<script>parent.embedded=true</script>"></iframe>
    </body></html>`;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/" || req.url === "/safe-root") {
      res.setHeader("content-type", "text/html");
      res.end(`<script>window.parentApiToken="parent-secret-only"</script><iframe id=frame sandbox="${framePolicy({ kind: "file", executionMode: "interactive" }, origin).sandbox}" src="${req.url === "/" ? "/interactive" : "/safe"}"></iframe>`);
    } else if (req.url === "/interactive" || req.url === "/safe") {
      const interactive = req.url === "/interactive";
      const csp = interactive ? interactiveFileCsp(origin) : "script-src 'nonce-frame-correlation-only' 'strict-dynamic'; object-src 'none'; base-uri 'self'";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp });
      res.end(injectSdk(interactive ? transformInteractiveHtml(source).html : source, "test-key", { src: `${origin}/sdk.js`, nonce: "frame-correlation-only", generation: 1 }));
    } else if (TRUSTED_SDK_MODULE_PATHS.includes(req.url)) {
      res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
      res.end(fs.readFileSync(fileURLToPath(new URL(`../lib${req.url}`, import.meta.url))));
    } else {
      res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
      res.end("window.externalRan = true");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(origin);
    const frame = page.frameLocator("#frame");
    await expect(frame.locator("#panel")).toHaveText("Overview");
    await expect.poll(() => frame.locator("body").evaluate(() => ({
      classic: window.inlineClassic, module: window.inlineModule,
      sdk: [...document.querySelectorAll("[data-eh-ui]")].some((node) => !!node.shadowRoot),
    }))).toEqual({ classic: true, module: true, sdk: true });
    await frame.locator("#tab").click();
    await expect(frame.locator("#panel")).toHaveText("Product");
    const state = await frame.locator("body").evaluate(() => ({
      origin: window.origin, blocked: window.blocked, stolen: window.stolen,
      external: window.externalRan, dataImport: window.dataImport, staticImport: window.staticImport,
      embedded: window.embedded,
    }));
    expect(state.origin).toBe("null");
    expect(state.blocked).toMatchObject({ dynamic: true, data: true, parent: true });
    expect(state.stolen).toBeUndefined();
    expect(state.external).toBeUndefined();
    expect(state.dataImport).toBeUndefined();
    expect(state.staticImport).toBeUndefined();
    expect(state.embedded).toBeUndefined();
    expect(requests).toContain("/sdk.js");
    for (const route of ["/authored-external.js", "/static-import.js", "/dynamic-import.js", "/worker.js", "/created-script.js", "/nonce-script.js"]) {
      expect(requests).not.toContain(route);
    }
    await expect(frame.locator('[data-eh-ui="trust-notice"]')).toHaveCount(0);
    await page.goto(`${origin}/safe-root`);
    await expect.poll(() => frame.locator("body").evaluate(() =>
      [...document.querySelectorAll("[data-eh-ui]")].some((node) => !!node.shadowRoot)
    )).toBe(true);
    await frame.locator("#tab").click();
    await expect(frame.locator("#panel")).toHaveText("Overview");
    expect(await frame.locator("body").evaluate(() => ({
      classic: window.inlineClassic, module: window.inlineModule, external: window.externalRan,
    }))).toEqual({ classic: undefined, module: undefined, external: undefined });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
