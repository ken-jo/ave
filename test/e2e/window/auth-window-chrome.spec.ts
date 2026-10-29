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
        args: [MAIN_ENTRY, `--user-data-dir=${resolve(home, "profile")}`, `--host-resolver-rules=MAP ${longHost} 127.0.0.1, MAP localhost 127.0.0.1`],
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
      await expect(chrome.locator("#oauth-domain")).toHaveText("127.0.0.1");
      await expect(chrome.locator("#oauth-security")).toHaveAttribute("data-security", "http");
      await expect(chrome.locator("#oauth-security")).toHaveAttribute("aria-label", /HTTP/);
      expect(await chrome.locator("input").count()).toBe(0);
      const geometry = await chrome.evaluate(() => {
        const row = document.getElementById("oauth-location")!;
        const host = document.getElementById("oauth-domain")!;
        const guest = document.getElementById("auth-view")!;
        return {
          row: row.getBoundingClientRect().toJSON(), host: host.getBoundingClientRect().toJSON(),
          guest: guest.getBoundingClientRect().toJSON(),
          hostHit: host.contains(document.elementFromPoint(host.getBoundingClientRect().x + 1, 18)),
        };
      });
      expect(geometry.row.height).toBe(36);
      expect(geometry.guest.y).toBe(geometry.row.bottom);
      expect(geometry.host.x).toBeGreaterThanOrEqual(process.platform === "darwin" ? 80 : 12);
      expect(geometry.host.right).toBeLessThan(geometry.row.right);
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
      async function checkAddress(url: string, display: string, elided = false): Promise<void> {
        await expect(chrome.locator("#oauth-domain")).toHaveText(display);
        await chrome.locator("#oauth-uri").hover();
        await expect(chrome.locator("#oauth-uri")).toHaveAttribute("title", url);
        const layout = await chrome.evaluate(() => {
          const uri = document.getElementById("oauth-uri")!;
          const domain = document.getElementById("oauth-domain")!;
          const range = document.createRange();
          range.selectNodeContents(domain);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          const clipboardData = new DataTransfer();
          const copy = new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true });
          uri.dispatchEvent(copy);
          const selected = selection.toString();
          const text = domain.firstChild!;
          range.setStart(text, Math.max(0, text.textContent!.length - 4));
          return {
            uri: uri.getBoundingClientRect().toJSON(), suffix: range.getBoundingClientRect().toJSON(),
            elided: uri.scrollWidth > uri.clientWidth, direction: getComputedStyle(uri).direction,
            drag: getComputedStyle(uri).getPropertyValue("-webkit-app-region"), selectable: getComputedStyle(uri).userSelect,
            selected, copied: clipboardData.getData("text/plain"), copyHandled: copy.defaultPrevented,
          };
        });
        expect(layout.elided).toBe(elided);
        expect(layout.direction).toBe("rtl");
        expect(layout.drag).toBe("no-drag");
        expect(layout.selectable).toBe("text");
        expect(layout.selected).toBe(display);
        expect(layout.copied).toBe(url);
        expect(layout.copyHandled).toBe(true);
        if (elided) {
          expect(display.endsWith(".com")).toBe(true);
          expect(layout.suffix.width).toBeGreaterThan(0);
          expect(layout.suffix.x).toBeGreaterThanOrEqual(layout.uri.x);
          expect(layout.suffix.right).toBeLessThanOrEqual(layout.uri.right);
        }
      }
      for (const [url, display] of [
        [`http://${longHost}:${address.port}${longPath}`, "attacker-example.io"],
        [`http://[::1]:${ipv6Address.port}${longPath}`, "[::1]"],
        [`http://localhost:${address.port}${longPath}`, "localhost"],
      ]) {
        await navigate(url);
        await checkAddress(url, display);
      }
      for (const platform of ["darwin", "win32", "linux"] as const) {
        for (const [url, display] of [
          ["https://accounts.google.com/o/oauth2/authorize?client_id=fixture#signin", "google.com"],
          ["https://" + longHost + ":8443/login?client_id=fixture", "attacker-example.io"],
          ["http://127.0.0.1:8443/login", "127.0.0.1"],
          ["http://localhost:8443/login", "localhost"],
          ["https://co.uk:8443/login", "co.uk"],
          ["about:blank", "about:blank"],
          ["https://" + "a".repeat(63) + ".com:8443/login?client_id=fixture", "a".repeat(63) + ".com"],
        ]) {
          await app.evaluate(async ({ BrowserWindow }, input) => {
            const vm = process.getBuiltinModule("node:vm");
            const service = await vm.runInThisContext(`import(${JSON.stringify(input.moduleUrl)})`, {
              importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
            });
            const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith("data:text/html"));
            if (!window) throw new Error("Missing authentication window");
            const html = service.buildAuthWindowShellHtml({ title: "Login", url: input.url, partition: "auth-layout", platform: input.platform, chromeOnly: true });
            await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
          }, { moduleUrl: pathToFileURL(resolve(chunks, moduleName)).href, platform, url });
          await checkAddress(url, display, display.length > 63);
        }
        await testInfo.attach(`${kind}-520-domain-only-${platform}`, { body: await chrome.screenshot(), contentType: "image/png" });
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
