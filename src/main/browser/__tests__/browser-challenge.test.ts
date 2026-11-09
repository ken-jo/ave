// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectBrowserChallenge } from "../browser-challenge.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";

const HINT = "The user can solve it in the web panel.";

function page(html: string) {
  document.body.innerHTML = html;
  let sequence = 0;
  const open = new Set<string>();
  const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "DOM.performSearch") {
      const result = document.evaluate(String(params?.query), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const searchId = `search-${++sequence}`;
      open.add(searchId);
      return { searchId, resultCount: result.snapshotLength };
    }
    if (method === "DOM.discardSearchResults") { open.delete(String(params?.searchId)); return {}; }
    throw new Error(`Unexpected read method: ${method}`);
  });
  return { send, open };
}

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("browser challenge annotation", () => {
  it.each(["Just a moment...", "  JUST A MOMENT…  ", "잠시만 기다려 주세요...", "잠시만 기다리십시오…", "잠시만 기다려 주십시오…"])("recognizes a complete waiting title: %s", async title => {
    const cdp = page("<main>Checking browser</main>");
    expect(await detectBrowserChallenge(cdp, title)).toEqual({ vendor: "cloudflare", hint: HINT });
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "token-form", vendor: "cloudflare", html: '<form id="challenge-form" action="/?__cf_chl_f_tk=fixture"></form>' },
    { kind: "waiting-container", vendor: "cloudflare", html: '<main id="cf-challenge">Checking browser</main>' },
    { kind: "response-frame", vendor: "datadome", html: '<iframe src="https://geo.captcha-delivery.com/captcha/?fixture=1"></iframe>' },
    { kind: "holding-control", vendor: "perimeterx", html: '<div id="px-captcha"><button>Press and hold</button></div>' },
    { kind: "security-container", vendor: "akamai", html: '<div id="sec-if-cpt-container"></div>' },
  ])("recognizes a dedicated $kind marker with an ordinary title", async ({ vendor, html }) => {
    const cdp = page(html);
    expect(await detectBrowserChallenge(cdp, "Example page")).toEqual({ vendor, hint: HINT });
    expect(cdp.open.size).toBe(0);
    expect(cdp.send.mock.calls.filter(([method]) => method === "DOM.performSearch").length).toBeLessThanOrEqual(4);
    expect(new Set(cdp.send.mock.calls.map(([method]) => method))).toEqual(new Set(["DOM.performSearch", "DOM.discardSearchResults"]));
  });

  it.each(["Verify you are human", "사람인지 확인해 주세요"])("recognizes a pending challenge control with a verification title: %s", async title => {
    const cdp = page('<div id="px-captcha"></div>');
    expect(await detectBrowserChallenge(cdp, title)).toEqual({ vendor: "perimeterx", hint: HINT });
    expect(cdp.open.size).toBe(0);
  });

  it.each([
    { title: "Verify you are human", html: '<div class="cf-turnstile" data-sitekey="fixture"></div>' },
    { title: "보안 확인", html: '<iframe src="https://challenges.cloudflare.com/turnstile/widget"></iframe>' },
  ])("recognizes a verification widget on a dedicated verification page ($title)", async ({ title, html }) => {
    const cdp = page(html);
    expect(await detectBrowserChallenge(cdp, title)).toEqual({ vendor: "cloudflare", hint: HINT });
    expect(cdp.open.size).toBe(0);
  });

  it.each([
    { title: "Just a moment with our support team", html: '<article>How browser challenges work</article>' },
    { title: "Example article", html: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script><div class="cf-turnstile"></div>' },
    { title: "Example article", html: '<iframe src="https://challenges.cloudflare.com/turnstile/widget"></iframe>' },
    { title: "Verify you are human", html: '<div class="cf-turnstile-reference"></div>' },
    { title: "Example article", html: '<script src="https://js.datadome.co/tags.js"></script><p>captcha-delivery.com</p>' },
    { title: "Example article", html: '<script src="https://client.perimeterx.net/example/main.min.js"></script><div id="px-captcha"></div>' },
    { title: "Example article", html: '<script src="https://example.test/akam/13/sensor.js"></script><pre>sec-if-cpt-container</pre>' },
    { title: "Security verification", html: '<form action="/login"><input name="captcha"></form>' },
    { title: "", html: '<p>Ordinary page</p>' },
  ])("does not classify an ordinary page ($title)", async ({ title, html }) => {
    const cdp = page(html);
    expect(await detectBrowserChallenge(cdp, title)).toBeUndefined();
    expect(cdp.open.size).toBe(0);
    expect(cdp.send.mock.calls.filter(([method]) => method === "DOM.performSearch")).toHaveLength(4);
  });

  it("discards each successful search handle before using another result", async () => {
    const cdp = page('<p>Ordinary page</p>');
    await detectBrowserChallenge(cdp, "Example page");
    expect(cdp.send.mock.calls.map(([method]) => method)).toEqual(Array.from({ length: 4 }, () => ["DOM.performSearch", "DOM.discardSearchResults"]).flat());
  });

  it("propagates a rejected lifecycle read without a successful annotation", async () => {
    const ended = new Error("browser action ended");
    const cdp = { send: vi.fn().mockRejectedValue(ended) };
    await expect(detectBrowserChallenge(cdp, "Example page")).rejects.toBe(ended);
    expect(cdp.send).toHaveBeenCalledTimes(1);
  });

  it("discards a valid handle even when its result count is invalid", async () => {
    const cdp = { send: vi.fn(async (method: string) => method === "DOM.performSearch" ? { searchId: "invalid-result", resultCount: -1 } : {}) };
    await expect(detectBrowserChallenge(cdp, "Example page")).rejects.toThrow("Invalid browser challenge search result");
    expect(cdp.send).toHaveBeenCalledWith("DOM.discardSearchResults", { searchId: "invalid-result" });
  });

  it.each([null, {}, { resultCount: 1 }])("refuses an unreadable search response without inventing a handle: %j", async response => {
    const cdp = { send: vi.fn(async () => response) };
    await expect(detectBrowserChallenge(cdp, "Example page")).rejects.toThrow("Invalid browser challenge search result");
    expect(cdp.send).toHaveBeenCalledTimes(1);
  });

  it("uses one total timeout and discards a handle arriving after that timeout", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const cdp = { send: vi.fn((method: string): Promise<unknown> => method === "DOM.performSearch" ? new Promise(done => { resolve = done; }) : Promise.resolve({})) };
    const pending = detectBrowserChallenge(cdp, "Example page");
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserChallengeProbeMs);
    await expect(pending).resolves.toBeUndefined();
    resolve({ searchId: "late-result", resultCount: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(cdp.send).toHaveBeenCalledWith("DOM.discardSearchResults", { searchId: "late-result" });
    expect(cdp.send.mock.calls.filter(([method]) => method === "DOM.performSearch")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("has a short independent budget for optional annotation", () => {
    expect(TOOL_TIMEOUT_POLICY.browserChallengeProbeMs).toBe(750);
  });

  it("shares the deadline across successive searches rather than resetting it", async () => {
    vi.useFakeTimers();
    let sequence = 0;
    const cdp = { send: vi.fn((method: string): Promise<unknown> => method === "DOM.performSearch"
      ? new Promise(resolve => { setTimeout(() => resolve({ searchId: `slow-${++sequence}`, resultCount: 0 }), Math.floor(TOOL_TIMEOUT_POLICY.browserChallengeProbeMs / 2) + 1); })
      : Promise.resolve({})) };
    const pending = detectBrowserChallenge(cdp, "Example page");
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserChallengeProbeMs);
    await expect(pending).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(cdp.send.mock.calls.filter(([method]) => method === "DOM.performSearch")).toHaveLength(2);
    expect(cdp.send).toHaveBeenCalledWith("DOM.discardSearchResults", { searchId: "slow-1" });
    expect(cdp.send).toHaveBeenCalledWith("DOM.discardSearchResults", { searchId: "slow-2" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts promptly and discards a handle arriving after cancellation", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const cdp = { send: vi.fn((method: string): Promise<unknown> => method === "DOM.performSearch" ? new Promise(done => { resolve = done; }) : Promise.resolve({})) };
    const controller = new AbortController();
    const ended = new Error("browser action cancelled");
    const pending = detectBrowserChallenge(cdp, "Example page", controller.signal);
    const refused = expect(pending).rejects.toBe(ended);
    controller.abort(ended);
    await refused;
    resolve({ searchId: "cancelled-result", resultCount: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(cdp.send).toHaveBeenCalledWith("DOM.discardSearchResults", { searchId: "cancelled-result" });
    expect(cdp.send.mock.calls.filter(([method]) => method === "DOM.performSearch")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not read when already cancelled", async () => {
    const cdp = page("<p>Ordinary page</p>");
    const controller = new AbortController();
    controller.abort(new Error("browser action cancelled"));
    await expect(detectBrowserChallenge(cdp, "Just a moment...", controller.signal)).rejects.toThrow("browser action cancelled");
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it("does not return a positive result after cancellation during cleanup", async () => {
    const controller = new AbortController();
    const ended = new Error("browser action cancelled");
    const cdp = { send: vi.fn(async (method: string) => {
      if (method === "DOM.performSearch") return { searchId: "found-result", resultCount: 1 };
      controller.abort(ended);
      return {};
    }) };
    await expect(detectBrowserChallenge(cdp, "Example page", controller.signal)).rejects.toBe(ended);
    expect(cdp.send).toHaveBeenCalledWith("DOM.discardSearchResults", { searchId: "found-result" });
  });
});
