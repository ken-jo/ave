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
    const longHost = "accounts.google.com.signin.oauth2.session-verify.attacker-example.io";
    const serve: import("node:http").RequestListener = (request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: longPath }).end();
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end('<title>trusted.example.test</title><div style="position:fixed;inset:0;z-index:2147483647;background:#ffe4d2;padding:32px;font:24px system-ui">Local sign-in fixture: full-page overlay</div>');
    };
    const server = createServer(serve);
    const ipv6Server = createServer(serve);
    let app: ElectronApplication | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      await new Promise<void>((resolve, reject) => { ipv6Server.once("error", reject); ipv6Server.listen(0, "::1", resolve); });
      const ipv6Address = ipv6Server.address();
      if (!ipv6Address || typeof ipv6Address === "string") throw new Error("Missing IPv6 fixture address");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      app = await launchElectron({
        args: [MAIN_ENTRY, `--user-data-dir=${resolve(home, "profile")}`, `--host-resolver-rules=MAP ${longHost} 127.0.0.1`],
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
          hostHit: host.contains(document.elementFromPoint(host.getBoundingClientRect().x + 1, 18)),
        };
      });
      expect(geometry.row.height).toBe(36);
      expect(geometry.guest.y).toBe(geometry.row.bottom);
      expect(geometry.host.x).toBeGreaterThanOrEqual(process.platform === "darwin" ? 80 : 12);
      expect(geometry.host.right).toBeLessThan(geometry.row.right);
      expect(geometry.elided).toBe(true);
      expect(geometry.hostHit).toBe(true);
      await testInfo.attach(`${kind}-address-chrome`, { body: await chrome.screenshot(), contentType: "image/png" });
      const authWindow = await app.browserWindow(chrome);
      await authWindow.evaluate(window => window.setSize(520, 600));
      async function navigate(url: string): Promise<void> {
        await app!.evaluate(async ({ webContents }, url) => {
          const guest = webContents.getAllWebContents().find(contents => contents.getType() === "webview");
          if (!guest) throw new Error("Missing auth guest");
          await guest.loadURL(url);
        }, url);
        await expect(chrome.locator("#oauth-uri")).toHaveAttribute("title", url);
      }
      for (const url of [`http://${longHost}:${address.port}${longPath}`, `http://[::1]:${ipv6Address.port}${longPath}`]) {
        await navigate(url);
        const layout = await chrome.evaluate(() => {
          const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect().toJSON();
          const subdomain = document.getElementById("oauth-subdomain")!;
          const uri = document.getElementById("oauth-uri")!;
          const path = document.getElementById("oauth-path")!;
          const selection = window.getSelection()!;
          const range = document.createRange();
          range.selectNodeContents(uri);
          selection.removeAllRanges();
          selection.addRange(range);
          const clipboardData = new DataTransfer();
          const copy = new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true });
          uri.dispatchEvent(copy);
          return {
            row: rect("oauth-location"), uri: rect("oauth-uri"), domain: rect("oauth-domain"), port: rect("oauth-port"),
            domainText: document.getElementById("oauth-domain")!.textContent,
            subdomainElided: subdomain.scrollWidth > subdomain.clientWidth,
            subdomainDirection: getComputedStyle(subdomain).direction,
            pathElided: path.scrollWidth > path.clientWidth,
            pathDirection: getComputedStyle(path).direction,
            dragRegion: getComputedStyle(uri).getPropertyValue("-webkit-app-region"),
            selectable: getComputedStyle(uri).userSelect,
            selected: selection.toString(), copied: clipboardData.getData("text/plain"), copyHandled: copy.defaultPrevented,
          };
        });
        expect(layout.row.width).toBe(520);
        expect(layout.domainText).toBe(url.includes(longHost) ? "attacker-example.io" : "[::1]");
        expect(layout.domain.right).toBeLessThanOrEqual(layout.uri.right);
        expect(layout.port.right).toBeLessThanOrEqual(layout.uri.right);
        expect(layout.port.right).toBeLessThanOrEqual(layout.row.right - 12);
        expect(layout.domain.x).toBeGreaterThanOrEqual(layout.uri.x);
        expect(layout.subdomainElided).toBe(url.includes(longHost));
        expect(layout.subdomainDirection).toBe("rtl");
        expect(layout.pathElided).toBe(true);
        expect(layout.pathDirection).toBe("ltr");
        expect(layout.dragRegion).toBe("no-drag");
        expect(layout.selectable).toBe("text");
        expect(layout.selected).toContain(layout.domainText);
        expect(layout.copied).toBe(url);
        expect(layout.copyHandled).toBe(true);
        await chrome.locator("#oauth-uri").hover();
        const name = `${kind}-520-${url.includes(longHost) ? "long-host" : "ipv6"}`;
        const screenshot = testInfo.outputPath(name + ".png");
        await chrome.screenshot({ path: screenshot });
        await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
      }
    } finally {
      await app?.close();
      for (const fixture of [server, ipv6Server]) {
        if (fixture.listening) await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
}
