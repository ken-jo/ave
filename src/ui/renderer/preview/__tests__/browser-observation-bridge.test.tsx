// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentObservationEvent, BrowserObservationDetail, BrowserObservationEvent } from "../../../../shared/agent-observation.js";
import { OBSERVATION_LIMITS } from "../../../../shared/agent-observation.js";
import type { AvePreviewApi } from "../../types.js";
import { BrowserObservationStore, connectBrowserObservations, releaseBrowserObservationSession } from "../browser-observation-bridge.js";
import { BrowserObservationLiveStrip } from "../BrowserObservationLiveStrip.js";

const SESSION = "browser-session";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function action(seq: number, after: Partial<BrowserObservationDetail> = {}, sessionId = SESSION, targetId = TARGET,
  hostSessionId = sessionId): BrowserObservationEvent {
  return { source: "browser", actor: "agent", sessionId, target: { id: targetId, path: "browser", hostSessionId }, seq,
    ts: 1_700_000_000_000 + seq, kind: "action", before: null,
    after: { action: "click", tabId: "tab-1", rendererTabId: "browser:1", url: "https://example.test/login", title: "Login",
      element: { ref: "e1", role: "button", name: "로그인", redacted: false }, ...after } };
}
function status(seq: number, code: "session-cleared" | "resync-required" | "observation-error", sessionId = SESSION,
  hostSessionId = sessionId): BrowserObservationEvent {
  return { source: "browser", actor: "agent", sessionId, target: { id: TARGET, path: "browser", hostSessionId }, seq,
    ts: 1_700_000_000_000 + seq, kind: "status", before: null, after: { code } };
}
let disconnect: (() => void) | undefined;
afterEach(() => { cleanup(); disconnect?.(); disconnect = undefined; });

describe("browser observation retention", () => {
  it("consumes the existing mixed-source channel without treating document data as browsing", () => {
    const ack = vi.fn(async () => ({ ok: true }));
    const store = new BrowserObservationStore(ack);
    const document: AgentObservationEvent = { source: "document", actor: "agent", sessionId: SESSION,
      target: { id: TARGET, path: "/workspace/example.txt" }, seq: 1, ts: 1_000,
      kind: "status", before: null, after: { code: "observation-error" } };
    store.accept([document]);
    expect(store.latest("browser:1", SESSION)).toBeUndefined();
    expect(ack).not.toHaveBeenCalled();
    store.accept([action(1)]);
    expect(store.latest("browser:1", SESSION)).toEqual(action(1));
    expect(store.latest("browser:other", SESSION)).toBeUndefined();
    expect(store.latest("browser:1", "another-session")).toBeUndefined();
    expect(ack).toHaveBeenCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 1 });
    store.dispose();
  });

  it("acknowledges each consumed target once per batch and ignores duplicates and target/session mismatches", () => {
    const ack = vi.fn(async () => ({ ok: true }));
    const store = new BrowserObservationStore(ack);
    store.accept([action(1), action(2), action(3)]);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenLastCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 3 });
    store.accept([action(2), action(3), action(4, {}, "another-session"), status(2, "session-cleared"),
      { ...status(4, "session-cleared"), sessionId: "another-session" }]);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(store.latest("browser:1", SESSION)?.seq).toBe(3);
    store.dispose();
  });

  it("retains only the bounded latest metadata and releases the oldest target at the target ceiling", () => {
    const ack = vi.fn(async () => ({ ok: true }));
    const store = new BrowserObservationStore(ack);
    for (let seq = 1; seq <= OBSERVATION_LIMITS.browserHistoryEvents + 1; seq++) {
      store.accept([action(seq, { rendererTabId: `browser:${seq}` })]);
    }
    expect(store.latest("browser:1", SESSION)).toBeUndefined();
    expect(store.latest("browser:2", SESSION)?.seq).toBe(2);
    for (let target = 1; target <= OBSERVATION_LIMITS.maxViews; target++) {
      store.accept([action(1, { rendererTabId: `browser:new-${target}` }, `session-${target}`, `target-${target}`)]);
    }
    expect(store.latest("browser:2", SESSION)).toBeUndefined();
    expect(ack).toHaveBeenCalledWith({ action: "release", targetId: TARGET, sessionId: SESSION,
      seq: OBSERVATION_LIMITS.browserHistoryEvents + 1 });
    store.dispose();
  });

  it("shows a child-owned close in its established parent session and isolates unrelated sessions", () => {
    const store = new BrowserObservationStore(async () => ({ ok: true }));
    store.accept([action(1, {}, SESSION, TARGET, "parent-session"), action(2, { action: "tab-close" }, SESSION, TARGET, "parent-session")]);
    expect(store.latest("browser:remaining", "parent-session")?.seq).toBe(2);
    expect(store.latest("browser:remaining", "unrelated-session")).toBeUndefined();
    store.releaseSession("parent-session");
    expect(store.latest("browser:1", SESSION)).toBeUndefined();
    store.dispose();
  });

  it("clears a host-ended session and prevents late acknowledgements from restoring it", async () => {
    let finish!: (result: { ok: boolean }) => void;
    const store = new BrowserObservationStore(() => new Promise((resolve) => { finish = resolve; }));
    store.accept([action(1)]);
    store.accept([status(2, "session-cleared")]);
    finish({ ok: false });
    await Promise.resolve();
    store.accept([action(3)]);
    expect(store.latest("browser:1", SESSION)).toBeUndefined();
    store.dispose();
  });

  it("makes acknowledgement failure visible and resumes with the next accepted action", async () => {
    const ack = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const store = new BrowserObservationStore(ack);
    store.accept([action(1)]);
    await Promise.resolve();
    expect(store.latest("browser:1", SESSION)).toMatchObject({ kind: "status", after: { code: "observation-error" } });
    store.accept([action(2)]);
    await Promise.resolve();
    expect(store.latest("browser:1", SESSION)).toMatchObject({ kind: "action", seq: 2 });
    store.dispose();
  });

  it("does not replace a newer action when an old acknowledgement fails", async () => {
    let finish!: (result: { ok: boolean }) => void;
    const ack = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ ok: true });
    const store = new BrowserObservationStore(ack);
    store.accept([action(1)]);
    store.accept([action(2)]);
    finish({ ok: false });
    await Promise.resolve();
    expect(store.latest("browser:1", SESSION)).toMatchObject({ kind: "action", seq: 2 });
    store.dispose();
  });
});

describe("browser observation live strip", () => {
  function connect() {
    let emit!: (events: AgentObservationEvent[]) => void;
    const off = vi.fn();
    const acknowledge = vi.fn(async () => ({ ok: true }));
    const api = { onAgentObservation: (handler: typeof emit) => { emit = handler; return off; },
      acknowledgeObservation: acknowledge, onObservationPreview: () => () => {},
      requestObservationPreview: async () => ({ ok: true }) } as unknown as AvePreviewApi;
    disconnect = connectBrowserObservations(api);
    return { emit, off, acknowledge };
  }

  it("stays absent for a user-only page and presents safe agent metadata without an interaction", () => {
    const { emit } = connect();
    const view = render(<BrowserObservationLiveStrip tabId="browser:1" sessionId={SESSION} />);
    const slot = screen.getByTestId("browser-observation-slot");
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(slot.textContent).toBe("");
    expect(screen.queryByTestId("browser-preview-live-strip")).toBeNull();
    act(() => emit([action(1)]));
    expect(screen.getByTestId("browser-observation-slot")).toBe(slot);
    expect(slot.hasAttribute("aria-hidden")).toBe(false);
    const strip = screen.getByTestId("browser-preview-live-strip");
    expect(strip.textContent).toContain("에이전트 브라우징");
    expect(strip.textContent).toContain("example.test/login · 클릭: ‘로그인’");
    expect(view.container.querySelector("button, input, textarea, [contenteditable=true]")).toBeNull();
    act(() => releaseBrowserObservationSession(SESSION));
    expect(screen.queryByTestId("browser-preview-live-strip")).toBeNull();
    expect(screen.getByTestId("browser-observation-slot")).toBe(slot);
    expect(slot.getAttribute("aria-hidden")).toBe("true");
  });

  it("redacts credential descriptions and renders download states without paths or values", () => {
    const { emit } = connect();
    render(<BrowserObservationLiveStrip tabId="browser:1" sessionId={SESSION} />);
    act(() => emit([action(1, { action: "type", element: { ref: "e2", role: "textbox", name: "discarded field", redacted: true } })]));
    expect(screen.getByTestId("browser-observation-summary").textContent).toContain("인증 정보 필드 (가림)");
    expect(screen.queryByText("discarded field")).toBeNull();
    act(() => emit([action(2, { action: "download", element: undefined, download: { state: "completed" } })]));
    expect(screen.getByTestId("browser-observation-summary").textContent).toContain("다운로드: 완료");
  });

  it("shows a child's borrowed-tab action in its host session without a remaining control lease", () => {
    const { emit } = connect();
    const view = render(<BrowserObservationLiveStrip tabId="browser:1" sessionId="parent-session" />);
    act(() => emit([action(1, {}, "child-session", TARGET, "parent-session")]));
    expect(screen.getByTestId("browser-observation-summary").textContent).toContain("클릭: ‘로그인’");
    view.rerender(<BrowserObservationLiveStrip tabId="browser:1" sessionId="unrelated-session" />);
    expect(screen.queryByTestId("browser-preview-live-strip")).toBeNull();
  });

  it("keeps observation errors in the single strip and drops it when the host clears the session", () => {
    const { emit, off } = connect();
    render(<BrowserObservationLiveStrip tabId="browser:1" sessionId={SESSION} />);
    act(() => emit([action(1), status(2, "resync-required")]));
    expect(screen.getAllByTestId("browser-preview-live-strip")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("브라우저 동작이 실시간 보기 한도를 초과했습니다");
    expect(screen.getByTestId("browser-observation-status").title).toBe(screen.getByTestId("browser-observation-status").textContent);
    act(() => emit([status(3, "session-cleared")]));
    expect(screen.queryByTestId("browser-preview-live-strip")).toBeNull();
    disconnect?.(); disconnect = undefined;
    expect(off).toHaveBeenCalledOnce();
  });

  it("shows an initial session overflow even when no action has reached the panel", () => {
    const { emit } = connect();
    render(<BrowserObservationLiveStrip tabId="browser:1" sessionId={SESSION} />);
    act(() => emit([status(1, "resync-required")]));
    expect(screen.getByRole("alert").textContent).toContain("브라우저 동작이 실시간 보기 한도를 초과했습니다");
  });

  it("routes an initial child overflow by the host target before any action or control state", () => {
    const { emit } = connect();
    const view = render(<BrowserObservationLiveStrip tabId="browser:1" sessionId="parent-session" />);
    act(() => emit([status(1, "resync-required", "child-session", "parent-session")]));
    expect(screen.getByRole("alert").textContent).toContain("브라우저 동작이 실시간 보기 한도를 초과했습니다");
    view.rerender(<BrowserObservationLiveStrip tabId="browser:1" sessionId="unrelated-session" />);
    expect(screen.queryByTestId("browser-preview-live-strip")).toBeNull();
  });
});
