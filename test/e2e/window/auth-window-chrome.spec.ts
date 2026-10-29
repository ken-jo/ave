import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildIsolatedElectronEnv, launchElectron, MAIN_ENTRY, REPO_ROOT } from "../ui/seeded-electron.js";

for (const kind of ["oauth", "cookie"] as const) {
  test(`${kind} login keeps the address above hostile page content after a redirect`, async ({}, testInfo) => {
    const home = mkdtempSync(resolve(tmpdir(), "ave-auth-chrome-"));
    const longPath = "/login/" + "long-path/".repeat(150);
    const server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: longPath }).end();
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end('<title>trusted.example.test</title><div style="position:fixed;inset:0;z-index:2147483647;background:#ffe4d2;padding:32px;font:24px system-ui">Local sign-in fixture: full-page overlay</div>');
    });
    let app: ElectronApplication | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      app = await launchElectron({
        args: [MAIN_ENTRY, `--user-data-dir=${resolve(home, "profile")}`],
        env: buildIsolatedElectronEnv({ AVE_HOME: resolve(home, "data") }),
      });
      await app.firstWindow();
      const chunks = resolve(REPO_ROOT, "dist/src/main/chunks");
      const moduleName = readdirSync(chunks).find(name => /^auth-window-service-.*\.js$/.test(name));
      if (!moduleName) throw new Error("Missing built authentication service");
      const [chrome] = await Promise.all([app.waitForEvent("window"), app.evaluate(async ({ BrowserWindow }, input) => {
        const vm = process.getBuiltinModule("node:vm");
        const service = await vm.runInThisContext(`import(${JSON.stringify(input.moduleUrl)})`, {
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        });
        const parent = BrowserWindow.getAllWindows()[0];
        const pending = input.kind === "oauth"
          ? service.openOAuthInAuthWindow(parent, input.url, { completion: new Promise(() => {}), onCancel() {}, timeoutMs: 60_000 })
          : service.openAuthWindow(parent, { url: input.url, completionUrlPatterns: ["/complete"], cookieHosts: ["127.0.0.1"], timeoutMs: 60_000 });
        void pending.catch(() => undefined);
      }, { moduleUrl: pathToFileURL(resolve(chunks, moduleName)).href, kind, url: origin + "/redirect" })]);
      await expect(chrome.locator("#oauth-uri")).toHaveAttribute("title", origin + longPath);
      await expect(chrome.locator("#oauth-host")).toHaveText(`127.0.0.1:${address.port}`);
      await expect(chrome.locator("#oauth-security")).toHaveAttribute("data-security", "http");
      await expect(chrome.locator("#oauth-security")).toHaveAttribute("aria-label", /HTTP/);
      expect(await chrome.locator("input").count()).toBe(0);
      const geometry = await chrome.evaluate(() => {
        const row = document.getElementById("oauth-location")!;
        const host = document.getElementById("oauth-host")!;
        const path = document.getElementById("oauth-path")!;
        const guest = document.getElementById("auth-view")!;
        return {
          row: row.getBoundingClientRect().toJSON(), host: host.getBoundingClientRect().toJSON(),
          guest: guest.getBoundingClientRect().toJSON(),
          elided: path.scrollWidth > path.clientWidth,
          hostText: document.elementFromPoint(host.getBoundingClientRect().x + 1, 18)?.textContent,
        };
      });
      expect(geometry.row.height).toBe(36);
      expect(geometry.guest.y).toBe(geometry.row.bottom);
      expect(geometry.host.x).toBeGreaterThanOrEqual(process.platform === "darwin" ? 80 : 12);
      expect(geometry.host.right).toBeLessThan(geometry.row.right);
      expect(geometry.elided).toBe(true);
      expect(geometry.hostText).toBe(`127.0.0.1:${address.port}`);
      await testInfo.attach(`${kind}-address-chrome`, { body: await chrome.screenshot(), contentType: "image/png" });
    } finally {
      await app?.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
}
