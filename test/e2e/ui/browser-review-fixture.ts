/** A local site and the shared steps for the browser review specs: every page is served from 127.0.0.1 on a free port. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expect } from "@playwright/test";
import type { Page } from "playwright";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, type SeededElectronContext } from "./seeded-electron.js";

export interface ReviewSite { readonly server: Server; readonly base: string; readonly port: number; readonly hits: string[] }
export type ReviewRoute = (request: IncomingMessage, response: ServerResponse, url: URL) => boolean;

function page(response: ServerResponse, body: string, title = "Fixture"): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>${title}</title><body style="font:16px system-ui;padding:24px">${body}`);
}

export async function startReviewSite(extra?: ReviewRoute): Promise<ReviewSite> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    hits.push(`${request.method} ${url.pathname}`);
    if (extra?.(request, response, url)) return;
    if (url.pathname === "/") return page(response, `<h1>Fixture home</h1><a id="other" href="/other">Other page</a>`, "Fixture home");
    if (url.pathname === "/other") return page(response, `<h1>Other page</h1><a href="/">home</a>`, "Other");
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<h1>404</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("review site has no address");
  return { server, port: address.port, base: `http://127.0.0.1:${address.port}`, hits };
}

export function reviewPage(response: ServerResponse, body: string, title?: string): true {
  page(response, body, title);
  return true;
}

export async function launchReviewApp(options: { prepareHome?: (aveHome: string) => void } = {}): Promise<SeededElectronContext> {
  const settings = buildLlmSettings() as Record<string, unknown>;
  settings.appearance = { ...(settings.appearance as Record<string, unknown>), language: "en", mode: "light" };
  return launchSeededElectron({
    settings, seedApiKey: true, sessionTitle: "Browser review",
    historyRows: [{ role: "user", content: "Browser review", createdAt: Date.now() }],
    ...(options.prepareHome ? { prepareHome: options.prepareHome } : {}),
  });
}

/** Opens the side panel when needed and adds a user browser tab to it. */
export async function openUserBrowserTab(window: Page): Promise<void> {
  const add = window.getByTestId("chat-side-panel-add-tab");
  if (!await add.isVisible()) await window.getByTestId(TEST_IDS.panePanelToggle).click();
  await add.click();
  await window.getByTestId("chat-side-panel-launcher-menu-browser").click();
  await expect(window.getByTestId("chat-side-panel-browser-address")).toBeVisible();
}

export async function typeAddress(window: Page, text: string): Promise<void> {
  const address = window.getByTestId("chat-side-panel-browser-address");
  await address.fill(text);
  await address.press("Enter");
}

/** The title of the user tab's page, read from the page itself rather than from the app's chrome. */
export function reviewGuestTitle(app: SeededElectronContext["app"]): Promise<string | undefined> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => contents.getType() === "webview")?.getTitle());
}

/** The names of the cookies the browser profile holds for an address. */
export function reviewCookieNames(app: SeededElectronContext["app"], url: string): Promise<string[]> {
  return app.evaluate(async ({ session }, target) => (await session.fromPartition("persist:ave-side-browser").cookies.get({ url: target })).map((cookie) => cookie.name), url);
}
