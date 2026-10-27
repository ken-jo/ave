import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserObservationAdapter } from "../browser-adapter.js";
import { ObservationDaemon } from "../daemon.js";
import { OBSERVATION_LIMITS, type BrowserObservationDetail, type BrowserObservationEvent } from "../../shared/agent-observation.js";

let daemon: ObservationDaemon;
let adapter: BrowserObservationAdapter;
let events: BrowserObservationEvent[];
const detail: BrowserObservationDetail = { action: "click", tabId: "tab-1", rendererTabId: "browser-one",
  url: "https://example.test/login", title: "Login", element: { ref: "e1", role: "button", name: "Sign in", redacted: false } };
function register(id = "target", sessionId = "session", isCurrent = () => true) {
  adapter.registerView({ id, sessionId, hostSessionId: sessionId, isCurrent, onEvents: (batch) => events.push(...batch) });
}
beforeEach(() => { vi.useFakeTimers(); daemon = new ObservationDaemon(); adapter = new BrowserObservationAdapter(daemon); events = []; });
afterEach(() => { daemon.dispose(); vi.useRealTimers(); });

describe("browser observation adapter", () => {
  it("uses daemon-owned browser identity and per-target monotonic sequence", async () => {
    register();
    adapter.record("target", detail); adapter.record("target", { ...detail, action: "type" });
    await vi.runAllTimersAsync();
    expect(events).toMatchObject([{ source: "browser", actor: "agent", sessionId: "session", target: { id: "target", path: "browser" }, seq: 1 }, { seq: 2 }]);
    adapter.acknowledge("target", 2);
    expect(events[0].after).toEqual(detail);
  });
  it("sanitizes URLs and credential target labels before delivery buffers", async () => {
    register();
    adapter.record("target", { ...detail, url: "https://user:secret@example.test/login?token=hidden#password",
      title: "Login\u202e\n", element: { ref: "e1", role: "textbox", name: "secret", redacted: true } });
    await vi.runAllTimersAsync();
    expect(JSON.stringify(events)).not.toMatch(/secret|hidden|password|token|user:/);
    expect(events[0].after).toMatchObject({ url: "https://example.test/login", title: "Login  ", element: { name: "", redacted: true } });
  });
  it("bounds metadata, strips unknown input fields and omits non-web URL contents", async () => {
    register();
    adapter.record("target", { ...detail, url: "data:text/plain,secret", title: "x".repeat(1000),
      element: { ...detail.element!, name: "n".repeat(1000), value: "secret" }, text: "secret" } as BrowserObservationDetail);
    await vi.runAllTimersAsync();
    expect(events[0].after).toMatchObject({ url: "", title: "x".repeat(OBSERVATION_LIMITS.browserTextChars),
      element: { name: "n".repeat(OBSERVATION_LIMITS.browserTextChars) } });
    expect(JSON.stringify(events)).not.toContain("secret");
  });
  it("retains bounded backpressure and reports overflow on the same source", async () => {
    register();
    for (let index = 0; index <= OBSERVATION_LIMITS.maxQueuedEvents; index++) adapter.record("target", detail);
    await vi.runAllTimersAsync();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "browser", kind: "status", after: { code: "resync-required" } });
  });
  it("sends a monotonic lifetime invalidation even under backpressure and releases queued data", async () => {
    register();
    for (let index = 0; index < 70; index++) adapter.record("target", detail);
    await vi.runAllTimersAsync();
    expect(events).toHaveLength(OBSERVATION_LIMITS.maxInFlightEvents);
    adapter.clear("target");
    await vi.runAllTimersAsync();
    expect(events.at(-1)).toMatchObject({ seq: 71, kind: "status", after: { code: "session-cleared" } });
    expect(() => adapter.record("target", detail)).toThrow("unavailable");
    expect(events).toHaveLength(OBSERVATION_LIMITS.maxInFlightEvents + 1);
  });
  it("shares the existing target limit and clearly rejects missing or malformed targets", () => {
    for (let index = 0; index < OBSERVATION_LIMITS.maxViews; index++) register(`target-${index}`);
    expect(() => register("excess")).toThrow("limit");
    expect(() => adapter.record("missing", detail)).toThrow("unavailable");
    expect(() => adapter.record("target-0", { ...detail, tabId: "untrusted" })).toThrow("identity");
    expect(() => adapter.record("target-0", { ...detail, url: "invalid" })).toThrow("URL");
  });
  it("releases a stale session without delivering its pending command", async () => {
    let current = true;
    register("target", "session", () => current);
    adapter.record("target", detail);
    current = false;
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
  });
});
