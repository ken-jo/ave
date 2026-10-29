/** Preload asset URLs must not depend on a splash-phase data: location. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, MAIN_CHAT_GROUP_ID } from "../contract/app-contract.js";
import type { SubAgentTranscriptRequest, SubAgentTranscriptResult } from "../shared/subagent-transcript.js";
import type { AgentObservationEvent } from "../shared/agent-observation.js";
import type { AveApi, AvePreviewApi } from "../ui/renderer/types.js";

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockSend = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockUserActivation = { isActive: false };
const originalDebugStreamEnv = process.env.VITE_DEBUG_STREAM;
const originalAveDebugStreamEnv = process.env.AVE_DEBUG_STREAM;
const originalAveDevEnv = process.env.AVE_DEV;
const originalAveE2eEnv = process.env.AVE_E2E;
const originalAveDevConsoleEnv = process.env.AVE_DEV_CONSOLE;

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, value: unknown) => {
      exposed.set(key, value);
    }),
  },
  ipcRenderer: {
    invoke: mockInvoke,
    send: mockSend,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
}));

// Define navigator when absent so defineProperty works across test runtimes.
if (typeof globalThis.navigator !== "object" || globalThis.navigator === null) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
}
Object.defineProperty(globalThis.navigator, "userActivation", {
  configurable: true,
  value: mockUserActivation,
});

type UserKeyboardIntentSnapshot = import("../shared/chat-origin.js").UserKeyboardIntentSnapshot;

async function loadAveApi(): Promise<Record<string, unknown>> {
  await import("../preload.js");
  const api = exposed.get("aveApi");
  if (!api || typeof api !== "object") {
    throw new Error("aveApi was not exposed");
  }
  return api as Record<string, unknown>;
}

async function loadAveNamespace(): Promise<Record<string, unknown>> {
  await import("../preload.js");
  const ave = exposed.get("ave");
  if (!ave || typeof ave !== "object") {
    throw new Error("ave was not exposed");
  }
  return ave as Record<string, unknown>;
}

describe("preload — plugin webview asset URLs", () => {
  beforeEach(() => {
    exposed.clear();
    mockInvoke.mockReset();
    mockSend.mockReset();
    mockOn.mockReset();
    mockRemoveListener.mockReset();
    mockUserActivation.isActive = false;
    vi.resetModules();
    delete process.env.VITE_DEBUG_STREAM;
    delete process.env.AVE_DEBUG_STREAM;
    delete process.env.AVE_DEV;
    delete process.env.AVE_E2E;
    delete process.env.AVE_DEV_CONSOLE;
  });

  it("limits the window surface to isolated previews and publishes the approved worlds", async () => {
    const api = await loadAveApi();
    const windowApi = api.window as Record<string, unknown>;
    expect(Object.keys(windowApi)).toEqual(["openHtmlPreview"]);
    expect(Object.keys(CHANNELS.window)).toEqual([
      "minimize", "toggleMaximize", "close", "syncTitleBarTheme", "maximizedChanged", "fullscreenChanged", "openHtmlPreview",
    ]);
    expect([...exposed.keys()].sort()).toEqual([
      "__aveDevMode", "__aveInitialTheme", "ave", "aveApi", "aveDrop", "aveHost", "avePlatform", "aveWindow",
    ]);
    expect(windowApi.openHtmlPreview).toBeTypeOf("function");
  });

  it.each(["rendered", "release"] as const)("passes only the read-only %s observation acknowledgement", async (action) => {
    const preview = (await loadAveNamespace()).preview as AvePreviewApi;
    const request = { action, targetId: "11111111-1111-4111-8111-111111111111", sessionId: "document-session", seq: 3 };
    await preview.acknowledgeObservation(request);
    expect(mockInvoke).toHaveBeenCalledWith(CHANNELS.preview.observationAck, request);
    expect(Object.keys(request).sort()).toEqual(["action", "seq", "sessionId", "targetId"]);
  });

  it("passes only the bounded browser preview request and subscribes to transient frames", async () => {
    const preview = (await loadAveNamespace()).preview as AvePreviewApi;
    const request = { action: "rendered" as const, targetId: "11111111-1111-4111-8111-111111111111", sessionId: "browser-session",
      tabId: "tab-1", frame: 2 };
    await preview.requestObservationPreview(request);
    expect(mockInvoke).toHaveBeenCalledWith(CHANNELS.preview.observationPreview, request);
    const handler = vi.fn();
    const unsubscribe = preview.onObservationPreview(handler);
    const listener = mockOn.mock.calls.findLast(([channel]) => channel === CHANNELS.preview.observationPreviewFrames)?.[1] as
      (event: unknown, message: unknown) => void;
    const message = { targetId: request.targetId, sessionId: request.sessionId, tabId: "tab-1", kind: "state", state: "updating" };
    listener({}, message);
    expect(handler).toHaveBeenCalledWith(message);
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(CHANNELS.preview.observationPreviewFrames, listener);
  });

  it("preserves preview reads and adds a session binding only when supplied", async () => {
    const preview = (await loadAveNamespace()).preview as AvePreviewApi;
    await preview.readDocument("/workspace/budget.xlsx", 0);
    await preview.readDocument("/workspace/budget.xlsx", 1, "document-session");
    expect(mockInvoke.mock.calls).toEqual([
      [CHANNELS.preview.readDocument, "/workspace/budget.xlsx", 0],
      [CHANNELS.preview.readDocument, "/workspace/budget.xlsx", 1, "document-session"],
    ]);
  });

  it("passes the optional text observation session through the existing read channel", async () => {
    const preview = (await loadAveNamespace()).preview as AvePreviewApi;
    await preview.readFile("src/value.ts");
    await preview.readFile("src/value.ts", { workspaceRoot: "/workspace", sessionId: "document-session" });
    expect(mockInvoke.mock.calls).toEqual([
      [CHANNELS.preview.readFile, "src/value.ts"],
      [CHANNELS.preview.readFile, "src/value.ts", { workspaceRoot: "/workspace", sessionId: "document-session" }],
    ]);
  });

  it("subscribes to local agent observations and removes the same listener", async () => {
    const preview = (await loadAveNamespace()).preview as AvePreviewApi;
    const handler = vi.fn();
    const unsubscribe = preview.onAgentObservation(handler);
    expect(mockOn).toHaveBeenCalledWith(CHANNELS.preview.observationEvents, expect.any(Function));
    const listener = mockOn.mock.calls.findLast(([channel]) => channel === CHANNELS.preview.observationEvents)?.[1] as
      (event: unknown, events: AgentObservationEvent[]) => void;
    const events: AgentObservationEvent[] = [{ source: "document", actor: "agent", sessionId: "document-session",
      target: { id: "11111111-1111-4111-8111-111111111111", path: "/workspace/budget.xlsx" },
      seq: 3, ts: 1_000, kind: "element", element: { kind: "cell", sheet: "Budget", row: 0, column: 1 },
      before: "12", after: "84", advisory: true },
      { source: "browser", actor: "agent", sessionId: "browser-session", target: { id: "22222222-2222-4222-8222-222222222222", path: "browser", hostSessionId: "browser-session" },
        seq: 1, ts: 1_000, kind: "action", before: null, after: { action: "click", tabId: "tab-1", rendererTabId: "browser:1",
          url: "https://example.test/", title: "Example", element: { ref: "e1", role: "button", name: "Continue", redacted: false } } }];
    listener({}, events);
    expect(handler).toHaveBeenCalledWith(events);
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(CHANNELS.preview.observationEvents, listener);
  });

  it("passes the terminal observation subscription on the existing acknowledgement channel", async () => {
    const preview = (await loadAveNamespace()).preview as AvePreviewApi;
    const request = { action: "subscribe-terminal" as const, sessionId: "terminal-session" };
    await preview.acknowledgeObservation(request);
    expect(mockInvoke).toHaveBeenCalledWith(CHANNELS.preview.observationAck, request);
    expect(Object.keys(request).sort()).toEqual(["action", "sessionId"]);
  });

  afterEach(() => {
    if (originalDebugStreamEnv === undefined) {
      delete process.env.VITE_DEBUG_STREAM;
    } else {
      process.env.VITE_DEBUG_STREAM = originalDebugStreamEnv;
    }
    if (originalAveDebugStreamEnv === undefined) {
      delete process.env.AVE_DEBUG_STREAM;
    } else {
      process.env.AVE_DEBUG_STREAM = originalAveDebugStreamEnv;
    }
    if (originalAveDevEnv === undefined) {
      delete process.env.AVE_DEV;
    } else {
      process.env.AVE_DEV = originalAveDevEnv;
    }
    if (originalAveE2eEnv === undefined) {
      delete process.env.AVE_E2E;
    } else {
      process.env.AVE_E2E = originalAveE2eEnv;
    }
    if (originalAveDevConsoleEnv === undefined) {
      delete process.env.AVE_DEV_CONSOLE;
    } else {
      process.env.AVE_DEV_CONSOLE = originalAveDevConsoleEnv;
    }
  });

  it("exposes pluginPreloadUrl as a file:// string under dist/src/", async () => {
    const api = await loadAveApi();
    const url = api["pluginPreloadUrl"];

    expect(typeof url).toBe("string");
    expect(url as string).toMatch(/^file:\/\//);
    expect(url as string).toMatch(/\/(dist\/)?src\/plugin-preload\.cjs$/i);
  });

  it("bridges the private Studio domain through its declared channels", async () => {
    mockInvoke.mockResolvedValue({ ok: true, value: [] });
    const api = await loadAveApi();
    const studio = api["pluginStudio"] as Record<string, (...args: unknown[]) => Promise<unknown>>;
    await studio["listDrafts"]!();
    await studio["readDraft"]!("team-kit");
    await studio["writeDraft"]!({ name: "team-kit" });
    await studio["previewInstallFromFile"]!();
    await studio["exportInstalled"]!("team-kit", true);
    expect(mockInvoke).toHaveBeenCalledWith(CHANNELS.pluginStudio.listDrafts);
    expect(mockInvoke).toHaveBeenCalledWith(CHANNELS.pluginStudio.readDraft, "team-kit");
    expect(mockInvoke).toHaveBeenCalledWith(CHANNELS.pluginStudio.writeDraft, { name: "team-kit" });
    expect(mockInvoke).toHaveBeenCalledWith(CHANNELS.pluginStudio.previewInstallFromFile);
    expect(mockInvoke).toHaveBeenCalledWith(CHANNELS.pluginStudio.exportInstalled, "team-kit", true);
  });

  it.each(["load", "send"] as const)("preserves the host pane target in a refused side-chat %s", async (operation) => {
    const refusal = { ok: false, error: "session-open-in-pane", paneTabId: "terminal:abcd1234-1", ...(operation === "load" ? { messages: [] } : {}) };
    mockInvoke.mockResolvedValueOnce(refusal);
    const api = await loadAveApi();
    const sideChat = api["sideChat"] as NonNullable<AveApi["sideChat"]>;
    await expect(operation === "load" ? sideChat.load("unlisted-session") : sideChat.send("prompt"))
      .resolves.toEqual(refusal);
  });

  it.each([undefined, "side-request"])("bridges side-chat send correlation %s on the existing channel", async (sendRequestId) => {
    mockInvoke.mockResolvedValueOnce({ ok: true, result: {} });
    const api = await loadAveApi();
    const sideChat = api["sideChat"] as NonNullable<AveApi["sideChat"]>;
    await sideChat.send("hello", [], "parent-session", sendRequestId);
    expect(mockInvoke.mock.calls).toEqual([[CHANNELS.sidechat.send, {
      input: "hello", attachments: [], originSessionId: "parent-session",
      ...(sendRequestId !== undefined ? { sendRequestId } : {}),
      inputOrigin: "queue-auto",
    }]]);
  });

  it("bridges a pane chat's surface and the side chat a view shows on send", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, result: {} });
    const api = await loadAveApi();
    const sideChat = api["sideChat"] as NonNullable<AveApi["sideChat"]>;
    const sessionId = "34fd6270-309d-4e47-878b-75c0742a6ac2";
    await sideChat.send("hello", [], undefined, "side-request", { kind: "terminal", tabId: "terminal:w-1" }, sessionId);
    expect(mockInvoke.mock.calls).toEqual([[CHANNELS.sidechat.send, {
      input: "hello", attachments: [], originSessionId: undefined, sendRequestId: "side-request",
      surface: { kind: "terminal", tabId: "terminal:w-1" }, sessionId, inputOrigin: "queue-auto",
    }]]);
  });

  it("reports a side-chat keyboard send as the user's only with a captured, unspent gesture token", async () => {
    const api = await loadAveApi();
    const capture = api["captureUserKeyboardIntent"] as () => unknown;
    const sideChat = api["sideChat"] as NonNullable<AveApi["sideChat"]>;
    const sent = () => mockInvoke.mock.calls.at(-1)![1] as { inputOrigin?: string; userActivation?: boolean };
    mockUserActivation.isActive = true;
    try {
      const token = capture() as UserKeyboardIntentSnapshot;
      await sideChat.send("typed", [], undefined, undefined, undefined, undefined, { inputOrigin: "user-keyboard", userIntent: token });
      expect(sent()).toMatchObject({ inputOrigin: "user-keyboard", userActivation: true });
      await sideChat.send("replayed", [], undefined, undefined, undefined, undefined, { inputOrigin: "user-keyboard", userIntent: token });
      expect(sent()).toMatchObject({ inputOrigin: "user-keyboard", userActivation: false });
      await sideChat.send("queued", [], undefined, undefined, undefined, undefined, { inputOrigin: "queue-auto" });
      expect(sent()).toMatchObject({ inputOrigin: "queue-auto" });
      expect(sent()).not.toHaveProperty("userActivation");
    } finally {
      mockUserActivation.isActive = false;
    }
  });

  it("consumes a branch click's token as the branch request leaves, so a slow fork cannot expire its auto-continue", async () => {
    const api = await loadAveApi();
    const capture = api["captureUserKeyboardIntent"] as () => UserKeyboardIntentSnapshot;
    const branch = api["chatBranchFromCheckpoint"] as (sessionId: string, compactNum: number, userIntent?: unknown) => Promise<unknown>;
    const continueLastUser = api["chatContinueLastUser"] as (sessionId: string, authority?: unknown) => Promise<unknown>;
    vi.useFakeTimers();
    mockUserActivation.isActive = true;
    try {
      const click = capture();
      mockUserActivation.isActive = false;
      await branch("source-session", 2, click);
      expect(mockInvoke).toHaveBeenLastCalledWith("ave:chat:branch-from-checkpoint", {
        sessionId: "source-session", compactNum: 2, intent: { inputOrigin: "user-keyboard", userActivation: true },
      }, "main");
      // The fork and load take longer than the token's lifetime; the continue spends main's grant, not the token.
      vi.advanceTimersByTime(6_000);
      await continueLastUser("branch-session", { branchContinuation: "grant-1" });
      expect(mockInvoke).toHaveBeenLastCalledWith("ave:chat:continue-last-user", { sessionId: "branch-session", branchContinuation: "grant-1" }, "main");
      // The token itself was spent by the branch request.
      await branch("source-session", 2, click);
      expect(mockInvoke).toHaveBeenLastCalledWith("ave:chat:branch-from-checkpoint", expect.objectContaining({
        intent: { inputOrigin: "user-keyboard", userActivation: false },
      }), "main");
    } finally {
      vi.useRealTimers();
      mockUserActivation.isActive = false;
    }
  });

  it("carries each replay's gesture token to main once: edit-resend, continue and retry", async () => {
    const api = await loadAveApi();
    const capture = api["captureUserKeyboardIntent"] as () => unknown;
    const editResend = api["chatEditResend"] as (id: string, text: string, userIntent?: unknown) => Promise<unknown>;
    const continueLastUser = api["chatContinueLastUser"] as (sessionId: string, userIntent?: unknown) => Promise<unknown>;
    const retryEffort = api["chatRetryEffort"] as (opts: unknown, userIntent?: unknown) => Promise<unknown>;
    const gesture = (activation: boolean) => ({ inputOrigin: "user-keyboard", userActivation: activation });
    mockUserActivation.isActive = true;
    try {
      const edit = capture();
      await editResend("row-1", "new", edit);
      expect(mockInvoke).toHaveBeenLastCalledWith("ave:chat:edit-resend", "row-1", "new", "main", gesture(true));
      await editResend("row-1", "again", edit);
      expect(mockInvoke).toHaveBeenLastCalledWith("ave:chat:edit-resend", "row-1", "again", "main", gesture(false));
      await continueLastUser("session-1", capture());
      expect(mockInvoke).toHaveBeenLastCalledWith("ave:chat:continue-last-user", { sessionId: "session-1", intent: gesture(true) }, "main");
      await continueLastUser("session-1");
      expect(mockInvoke).toHaveBeenLastCalledWith("ave:chat:continue-last-user", { sessionId: "session-1", intent: gesture(false) }, "main");
      await retryEffort({ enableThinking: true }, capture());
      expect(mockInvoke).toHaveBeenLastCalledWith("ave:chat:retry-effort", { enableThinking: true }, "main", gesture(true));
      await retryEffort({ enableThinking: true });
      expect(mockInvoke).toHaveBeenLastCalledWith("ave:chat:retry-effort", { enableThinking: true }, "main", gesture(false));
    } finally {
      mockUserActivation.isActive = false;
    }
  });

  it("bridges a pane chat's history read and its ending", async () => {
    mockInvoke.mockResolvedValue({ ok: true, sessionId: null, messages: [] });
    const api = await loadAveApi();
    const sideChat = api["sideChat"] as NonNullable<AveApi["sideChat"]>;
    await sideChat.paneHistory("browser:w-2");
    await sideChat.endPaneChat("browser:w-2", "closed");
    expect(mockInvoke.mock.calls).toEqual([
      [CHANNELS.sidechat.paneHistory, { tabId: "browser:w-2" }],
      [CHANNELS.sidechat.endPaneChat, { tabId: "browser:w-2", reason: "closed" }],
    ]);
  });

  it("bridges side-chat cancellation identity on the existing channel", async () => {
    const sendRequestId = "side-request";
    mockInvoke.mockResolvedValueOnce({ ok: true });
    const api = await loadAveApi();
    const sideChat = api["sideChat"] as NonNullable<AveApi["sideChat"]>;
    await sideChat.abort(sendRequestId);
    expect(mockInvoke.mock.calls).toEqual([[CHANNELS.sidechat.abort, { sendRequestId }]]);
  });

  it("bridges side-chat child transcripts with only the explicit owner request", async () => {
    const request: SubAgentTranscriptRequest = {
      originSessionId: "side-origin",
      childSessionId: "side-child",
    };
    const response: SubAgentTranscriptResult = {
      ok: true,
      childSessionId: request.childSessionId,
      messages: [{ index: 0, role: "assistant", content: "Persisted child answer" }],
      title: "Child transcript",
      spawnId: "side-spawn",
      originToolUseId: "side-tool-use",
    };
    mockInvoke.mockResolvedValueOnce(response);
    const api = await loadAveApi();
    const sideChat = api["sideChat"] as NonNullable<AveApi["sideChat"]>;

    expect(typeof sideChat.getSubAgentTranscript).toBe("function");
    const result = await sideChat.getSubAgentTranscript!(request);

    expect(result).toEqual(response);
    expect(mockInvoke.mock.calls).toEqual([[CHANNELS.sidechat.getSubAgentTranscript, request]]);
  });

  it("returns side-chat transcript refusals without a tile read", async () => {
    const request: SubAgentTranscriptRequest = {
      originSessionId: "side-origin",
      childSessionId: "foreign-child",
    };
    const response: SubAgentTranscriptResult = { ok: false, error: "sub-agent-reference-not-found" };
    mockInvoke.mockResolvedValueOnce(response);
    const api = await loadAveApi();
    const sideChat = api["sideChat"] as NonNullable<AveApi["sideChat"]>;

    expect(typeof sideChat.getSubAgentTranscript).toBe("function");
    const result = await sideChat.getSubAgentTranscript!(request);

    expect(result).toEqual(response);
    expect(mockInvoke.mock.calls).toEqual([[CHANNELS.sidechat.getSubAgentTranscript, request]]);
  });

  it.each([MAIN_CHAT_GROUP_ID, "group-2"])("keeps tile child transcript reads scoped to %s", async (chatGroupId) => {
    const request: SubAgentTranscriptRequest = {
      originSessionId: "tile-origin",
      childSessionId: "tile-child",
    };
    const response: SubAgentTranscriptResult = { ok: true, childSessionId: request.childSessionId, messages: [] };
    mockInvoke.mockResolvedValueOnce(response);
    const { buildPublicSurface } = await import("../preload/public-surface.js");
    const publicApi = buildPublicSurface();
    const surface = chatGroupId === MAIN_CHAT_GROUP_ID ? publicApi : publicApi.chatGroup(chatGroupId);

    const result = await surface.chatGetSubAgentTranscript(request);

    expect(result).toEqual(response);
    expect(mockInvoke.mock.calls).toEqual([[CHANNELS.chat.getSubAgentTranscript, request, chatGroupId]]);
    expect("sideChat" in surface).toBe(false);
  });

  it.each([MAIN_CHAT_GROUP_ID, "tile-2"])("preserves rewind group and restore choice for %s", async (chatGroupId) => {
    const { buildPublicSurface } = await import("../preload/public-surface.js");
    const api = buildPublicSurface();
    const surface = chatGroupId === MAIN_CHAT_GROUP_ID ? api : api.chatGroup(chatGroupId);
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "code-restore-conflict", conflictingFiles: ["/workspace/code.ts"] });
    expect(await surface.chatRewindTo("user-row", "both")).toEqual({ ok: false, error: "code-restore-conflict", conflictingFiles: ["/workspace/code.ts"] });
    expect(mockInvoke).toHaveBeenCalledWith(CHANNELS.chat.rewindTo, "user-row", chatGroupId, "both");
  });

  it.each([MAIN_CHAT_GROUP_ID, "tile-2"])("binds readonly turn review to %s", async (chatGroupId) => {
    const { buildPublicSurface } = await import("../preload/public-surface.js");
    const api = buildPublicSurface();
    const surface = chatGroupId === MAIN_CHAT_GROUP_ID ? api : api.chatGroup(chatGroupId);
    mockInvoke.mockResolvedValue({ ok: false, error: "turn-review-stale" });
    await expect(surface.chatGetTurnReview("expected-session")).resolves.toEqual({ ok: false, error: "turn-review-stale" });
    expect(mockInvoke).toHaveBeenLastCalledWith(CHANNELS.chat.getTurnReview, "expected-session", chatGroupId);
  });

  it("exposes pluginShellUrl as a file:// string under dist/src/", async () => {
    const api = await loadAveApi();
    const url = api["pluginShellUrl"];

    expect(typeof url).toBe("string");
    expect(url as string).toMatch(/^file:\/\//);
    expect(url as string).toMatch(/\/plugin-ui-shell\.html$/i);
  });

  it("bridges render_html previews through the exact window IPC channel", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, windowId: 9 });
    const api = await loadAveApi();
    const windowApi = api["window"] as Record<string, unknown>;
    const payload = {
      html: "<main>preview</main>",
      title: "Preview",
      allowScripts: true,
    };

    const result = await (windowApi["openHtmlPreview"] as (value: typeof payload) => Promise<unknown>)(payload);

    expect(result).toEqual({ ok: true, windowId: 9 });
    expect(mockInvoke).toHaveBeenCalledWith("ave:window:open-html-preview", payload);
  });

  it("plugin asset URLs are static strings, not functions", async () => {
    const api = await loadAveApi();

    expect(typeof api["pluginPreloadUrl"]).toBe("string");
    expect(typeof api["pluginShellUrl"]).toBe("string");
    expect(typeof api["pluginPreloadUrl"]).not.toBe("function");
    expect(typeof api["pluginShellUrl"]).not.toBe("function");
  });

  it("exposes chat user-intent capture through preload", async () => {
    const api = await loadAveApi();

    expect(typeof api["captureUserKeyboardIntent"]).toBe("function");
  });

  it("keeps provider-backed usage daily summary out of the public preload surface", async () => {
    const { buildPublicSurface } = await import("../preload/public-surface.js");
    const publicApi = buildPublicSurface() as Record<string, unknown>;

    expect(typeof publicApi["getUsageSummary"]).toBe("function");
    expect(typeof publicApi["getUsageRange"]).toBe("function");
    expect(publicApi["getUsageDailySummary"]).toBeUndefined();
  });

  it("exposes settings updated subscription through preload", async () => {
    const api = await loadAveApi();
    const handler = vi.fn();
    const unsubscribe = (api["onSettingsUpdated"] as (cb: (settings: unknown) => void) => () => void)(handler);

    expect(mockOn).toHaveBeenCalledWith("ave:settings:updated", expect.any(Function));
    const listener = mockOn.mock.calls.at(-1)?.[1] as (event: unknown, settings: unknown) => void;
    const settings = { appearance: { schemaVersion: 2, bundleId: "forest" } };
    listener({}, settings);
    expect(handler).toHaveBeenCalledWith(settings);

    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith("ave:settings:updated", listener);
  });
  it("exposes only validated subscription runtime status invalidations through preload", async () => {
    const api = await loadAveApi();
    const handler = vi.fn();
    const subscribe = api["onSubscriptionRuntimeStatusUpdated"] as (cb: (event: unknown) => void) => () => void;
    const unsubscribe = subscribe(handler);

    expect(mockOn).toHaveBeenCalledWith("ave:settings:subscription:status-updated", expect.any(Function));
    const listener = mockOn.mock.calls.at(-1)?.[1] as (event: unknown, payload: unknown) => void;
    const validEvent = { provider: "codex", revision: 7 };
    listener({}, validEvent);
    listener({}, { provider: "codex", revision: 8, verificationUrl: "https://example.test/secret" });
    listener({}, { provider: "not-a-provider", revision: 9 });
    listener({}, { provider: "codex", revision: 0 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(validEvent);

    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith("ave:settings:subscription:status-updated", listener);
  });

  it.each([
    ["codexSubscriptionStatus", "ave:settings:codex-subscription:status"],
    ["codexSubscriptionStartBrowserLogin", "ave:settings:codex-subscription:start-browser-login"],
    ["codexSubscriptionStartDeviceCodeLogin", "ave:settings:codex-subscription:start-device-code-login"],
    ["codexSubscriptionCancelLogin", "ave:settings:codex-subscription:cancel-login"],
    ["codexSubscriptionLogout", "ave:settings:codex-subscription:logout"],
    ["codexSubscriptionListModels", "ave:settings:codex-subscription:list-models"],
  ])("exposes %s through the internal Codex subscription bridge", async (apiKey, channel) => {
    const api = await loadAveApi();
    const action = api[apiKey];

    expect(typeof action).toBe("function");
    await (action as () => Promise<unknown>)();

    expect(mockInvoke).toHaveBeenCalledWith(channel);
  });

  it.each([
    ["acpSubscriptionStatus", "ave:settings:acp-subscription:status"],
    ["acpSubscriptionChooseRuntime", "ave:settings:acp-subscription:choose-runtime"],
    ["acpSubscriptionForgetRuntime", "ave:settings:acp-subscription:forget-runtime"],
    ["acpSubscriptionVerify", "ave:settings:acp-subscription:verify"],
    ["acpSubscriptionStartLogin", "ave:settings:acp-subscription:start-login"],
    ["acpSubscriptionCancelLogin", "ave:settings:acp-subscription:cancel-login"],
    ["acpSubscriptionLogout", "ave:settings:acp-subscription:logout"],
    ["acpSubscriptionOpenLoginBrowser", "ave:settings:acp-subscription:open-login-browser"],
  ])("exposes %s through the internal ACP subscription bridge", async (apiKey, channel) => {
    const api = await loadAveApi();
    const action = api[apiKey];

    expect(typeof action).toBe("function");
    await (action as (provider: string) => Promise<unknown>)("kimi-code");

    expect(mockInvoke).toHaveBeenCalledWith(channel, "kimi-code");
  });

  it.each([
    ["subscriptionRuntimeStatus", "ave:settings:subscription:status", ["codex"]],
    ["subscriptionChooseRuntime", "ave:settings:subscription:choose-runtime", ["kimi-code"]],
    ["subscriptionForgetRuntime", "ave:settings:subscription:forget-runtime", ["kimi-code"]],
    ["subscriptionVerifyRuntime", "ave:settings:subscription:verify", ["codex"]],
    ["subscriptionStartLogin", "ave:settings:subscription:start-login", ["codex", "browser"]],
    ["subscriptionOpenLoginBrowser", "ave:settings:subscription:open-login-browser", ["kimi-code"]],
    ["subscriptionCancelLogin", "ave:settings:subscription:cancel-login", ["codex"]],
    ["subscriptionAcknowledgeNotice", "ave:settings:subscription:acknowledge-notice", ["chatgpt-plan"]],
    ["subscriptionLogout", "ave:settings:subscription:logout", ["codex"]],
    ["subscriptionListModels", "ave:settings:subscription:list-models", ["codex"]],
    ["subscriptionUseForChat", "ave:settings:subscription:use-for-chat", ["codex", "gpt-5"]],
    ["subscriptionUseApiForChat", "ave:settings:subscription:use-api-for-chat", []],
  ])("exposes %s through the common subscription bridge", async (apiKey, channel, args) => {
    const api = await loadAveApi();
    const action = api[apiKey];

    expect(typeof action).toBe("function");
    await (action as (...values: unknown[]) => Promise<unknown>)(...args);

    expect(mockInvoke).toHaveBeenCalledWith(channel, ...args);
  });

  it("does not trust renderer-minted chat userActivation flags", async () => {
    const api = await loadAveApi();
    const chatSend = api["chatSend"] as (
      input: string,
      attachments: unknown[] | undefined,
      inputOrigin: string,
      userIntent?: unknown,
    ) => Promise<unknown>;

    await chatSend("hello", undefined, "user-keyboard", {
      inputOrigin: "user-keyboard",
      userActivation: true,
    });

    expect(mockInvoke).toHaveBeenCalledWith("ave:chat:send", expect.objectContaining({
      input: "hello",
      inputOrigin: "user-keyboard",
      userActivation: false,
    }), "main");
  });

  it("does not trust renderer-minted plugin userAction flags", async () => {
    const api = await loadAveApi();
    const callPluginMethod = api["callPluginMethod"] as (
      method: string,
      payload?: unknown,
      options?: { userAction?: boolean },
    ) => Promise<unknown>;

    await callPluginMethod("sample_ui_action", { id: 1 }, { userAction: true });

    expect(mockInvoke).toHaveBeenCalledWith("ave:plugins:call", "sample_ui_action", { id: 1 }, {
      userAction: false,
    });
  });

  it("forwards plugin userAction only during active browser user activation", async () => {
    mockUserActivation.isActive = true;
    const api = await loadAveApi();
    const callPluginMethod = api["callPluginMethod"] as (
      method: string,
      payload?: unknown,
      options?: { userAction?: boolean },
    ) => Promise<unknown>;

    await callPluginMethod("sample_ui_action", undefined, { userAction: true });

    expect(mockInvoke).toHaveBeenCalledWith("ave:plugins:call", "sample_ui_action", undefined, {
      userAction: true,
    });
  });

  it("forwards the opaque operation grant token on plugin calls", async () => {
    const api = await loadAveApi();
    const callPluginMethod = api["callPluginMethod"] as (
      method: string,
      payload?: unknown,
      options?: { operationGrantToken?: string },
    ) => Promise<unknown>;

    await callPluginMethod(
      "checkin_write",
      { operation: "clock_in" },
      { operationGrantToken: "grant-once" },
    );

    expect(mockInvoke).toHaveBeenCalledWith(
      "ave:plugins:call",
      "checkin_write",
      { operation: "clock_in" },
      { userAction: false, operationGrantToken: "grant-once" },
    );
  });

  it("forwards only the server id for remote authentication", async () => {
    const api = await loadAveApi();
    const mcp = api["mcp"] as { authenticate(id: string): Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ connected: false, errorCode: "mcp-auth-required" });
    await expect(mcp.authenticate("remote-a")).resolves.toEqual({ connected: false, errorCode: "mcp-auth-required" });
    expect(mockInvoke).toHaveBeenCalledWith("ave:mcp:authenticate", "remote-a");
  });

  it("pins MCP app resource and tool calls to the supplied generation", async () => {
    const api = await loadAveApi();
    const mcp = api["mcp"] as {
      readUiResource(
        serverId: string,
        uri: string,
        generationId?: string,
      ): Promise<unknown>;
      callTool(
        serverId: string,
        name: string,
        args: Record<string, unknown>,
        generationId?: string,
      ): Promise<unknown>;
    };

    await mcp.readUiResource("plugin:sampleportal:mcp:work", "ui://checkin", "generation-a");
    await mcp.callTool(
      "plugin:sampleportal:mcp:work",
      "checkin_read",
      { operation: "today" },
      "generation-a",
    );

    expect(mockInvoke).toHaveBeenCalledWith(
      "ave:mcp:ui-resource",
      "plugin:sampleportal:mcp:work",
      "ui://checkin",
      "generation-a",
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      "ave:mcp:call-tool",
      "plugin:sampleportal:mcp:work",
      "checkin_read",
      { operation: "today" },
      "generation-a",
    );
  });

  it("consumes captured chat user-intent tokens exactly once", async () => {
    mockUserActivation.isActive = true;
    const api = await loadAveApi();
    const capture = api["captureUserKeyboardIntent"] as () => unknown;
    const chatSend = api["chatSend"] as (
      input: string,
      attachments: unknown[] | undefined,
      inputOrigin: string,
      userIntent?: unknown,
    ) => Promise<unknown>;
    const token = capture();

    await chatSend("first", undefined, "user-keyboard", token);
    mockUserActivation.isActive = false;
    await chatSend("second", undefined, "user-keyboard", token);

    // A required group id prevents turns from losing their originating tile.
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "ave:chat:send", expect.objectContaining({
      input: "first",
      userActivation: true,
    }), "main");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "ave:chat:send", expect.objectContaining({
      input: "second",
      userActivation: false,
    }), "main");
  });

  it("never lets lingering activation rescue a missing, replayed, forged or expired chat send intent", async () => {
    const api = await loadAveApi();
    const capture = api["captureUserKeyboardIntent"] as () => unknown;
    const chatSend = api["chatSend"] as (input: string, attachments: unknown[] | undefined, inputOrigin: string, userIntent?: unknown) => Promise<unknown>;
    const activation = () => (mockInvoke.mock.calls.at(-1)![1] as { userActivation?: boolean }).userActivation;
    mockUserActivation.isActive = true;
    const token = capture();
    await chatSend("first", undefined, "user-keyboard", token);
    expect(activation()).toBe(true);
    await chatSend("replayed", undefined, "user-keyboard", token);
    expect(activation()).toBe(false);
    await chatSend("forged", undefined, "user-keyboard", { inputOrigin: "user-keyboard", token: "not-minted" });
    expect(activation()).toBe(false);
    await chatSend("missing", undefined, "user-keyboard");
    expect(activation()).toBe(false);
    vi.useFakeTimers();
    try {
      const stale = capture();
      vi.advanceTimersByTime(5_001);
      await chatSend("late", undefined, "user-keyboard", stale);
      expect(activation()).toBe(false);
    } finally {
      vi.useRealTimers();
      mockUserActivation.isActive = false;
    }
  });

  it("marks a chat guide as the user's own words only with a fresh, unused composer intent", async () => {
    const api = await loadAveApi();
    const capture = api["captureUserKeyboardIntent"] as () => unknown;
    const chatGuide = api["chatGuide"] as (input: string, userIntent?: unknown) => Promise<unknown>;
    const intentOf = (call: number) => mockInvoke.mock.calls[call]![3];

    // No gesture at all (a queue flush at a round boundary), even while the browser still reports activation.
    mockUserActivation.isActive = true;
    await chatGuide("flushed");
    expect(mockInvoke.mock.calls[0]!.slice(0, 3)).toEqual(["ave:chat:guide", "flushed", "main"]);
    expect(intentOf(0)).toEqual({ inputOrigin: "user-keyboard", userActivation: false });

    // A renderer-minted claim is not an intent.
    mockUserActivation.isActive = false;
    await chatGuide("forged", { inputOrigin: "user-keyboard", userActivation: true });
    expect(intentOf(1)).toEqual({ inputOrigin: "user-keyboard", userActivation: false });

    // A real composer gesture: captured during the key handler, consumed once. Activation lingers after the gesture, and it rescues neither
    // the replayed token nor a forged one.
    mockUserActivation.isActive = true;
    const token = capture();
    await chatGuide("typed", token);
    expect(intentOf(2)).toEqual({ inputOrigin: "user-keyboard", userActivation: true });
    await chatGuide("replayed", token);
    expect(intentOf(3)).toEqual({ inputOrigin: "user-keyboard", userActivation: false });
    await chatGuide("forged token", { inputOrigin: "user-keyboard", token: "not-minted" });
    expect(mockInvoke.mock.calls.at(-1)![3]).toEqual({ inputOrigin: "user-keyboard", userActivation: false });
    mockUserActivation.isActive = false;

    // An expired intent confers nothing.
    vi.useFakeTimers();
    try {
      mockUserActivation.isActive = true;
      const stale = capture();
      mockUserActivation.isActive = false;
      vi.advanceTimersByTime(5_001);
      mockUserActivation.isActive = true;
      await chatGuide("late", stale);
      expect(mockInvoke.mock.calls.at(-1)![3]).toEqual({ inputOrigin: "user-keyboard", userActivation: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes renderer env flags including debugStream", async () => {
    const ave = await loadAveNamespace();
    const env = ave["env"] as Record<string, unknown>;

    expect(env).toMatchObject({
      isDev: false,
      isE2E: false,
      enableDevConsole: false,
      debugStream: false,
    });
  });

  it("reflects AVE_E2E in the preload bridge", async () => {
    process.env.AVE_E2E = "1";
    const ave = await loadAveNamespace();
    const env = ave["env"] as Record<string, unknown>;

    expect(env["isE2E"]).toBe(true);
    expect(env["debugStream"]).toBe(false);
  });

  it("does not treat AVE_E2E as dev mode by itself", async () => {
    process.env.AVE_E2E = "1";
    const ave = await loadAveNamespace();
    const env = ave["env"] as Record<string, unknown>;

    expect(env["isDev"]).toBe(false);
    expect(env["isE2E"]).toBe(true);
  });

  it("reflects VITE_DEBUG_STREAM in the preload bridge", async () => {
    process.env.VITE_DEBUG_STREAM = "1";
    const ave = await loadAveNamespace();
    const env = ave["env"] as Record<string, unknown>;

    expect(env["debugStream"]).toBe(true);
  });

  it("keeps debugStream separate from the dev console flag", async () => {
    process.env.AVE_DEV = "1";
    process.env.AVE_DEV_CONSOLE = "1";
    const ave = await loadAveNamespace();
    const env = ave["env"] as Record<string, unknown>;

    expect(env["enableDevConsole"]).toBe(true);
    expect(env["debugStream"]).toBe(false);
  });

  it("reflects AVE_DEBUG_STREAM in the preload bridge", async () => {
    process.env.AVE_DEV = "1";
    process.env.AVE_DEV_CONSOLE = "1";
    process.env.AVE_DEBUG_STREAM = "1";
    const ave = await loadAveNamespace();
    const env = ave["env"] as Record<string, unknown>;

    expect(env["debugStream"]).toBe(true);
  });

  it("exposes memoryGetIndex and invokes the memory index IPC channel", async () => {
    const api = await loadAveApi();

    expect(typeof api["memoryGetIndex"]).toBe("function");
    expect(api["memoryUpdateIndex"]).toBeUndefined();
    await (api["memoryGetIndex"] as () => Promise<unknown>)();

    expect(mockInvoke).toHaveBeenCalledWith("ave:memory:index:get");
  });

  it("bridges candidate review actions with immutable ids and optional project scope", async () => {
    const api = await loadAveApi();
    const candidateId = "ce882fc4-19c5-4e9e-98cd-6405a608b73f";
    const project = { projectRoot: "/workspace/project", projectName: "project" };

    await (api["memoryListCandidates"] as () => Promise<unknown>)();
    await (api["memoryActivateCandidate"] as (id: string, opts?: typeof project) => Promise<unknown>)(candidateId);
    await (api["memoryDeleteCandidate"] as (id: string, opts?: typeof project) => Promise<unknown>)(candidateId, project);
    await (api["memoryDeleteEntry"] as (filename: string, opts?: typeof project) => Promise<unknown>)("note.md", project);

    expect(mockInvoke).toHaveBeenCalledWith("ave:memory:candidates:list");
    expect(mockInvoke).toHaveBeenCalledWith("ave:memory:candidates:activate", { id: candidateId });
    expect(mockInvoke).toHaveBeenCalledWith("ave:memory:candidates:delete", {
      id: candidateId,
      opts: project,
    });
    expect(mockInvoke).toHaveBeenCalledWith("ave:memory:entries:delete", "note.md", project);
  });

  it.each([
    ["memoryGetAgentsMd", "ave:memory:agents-md:get"],
    ["memoryUpdateAgentsMd", "ave:memory:agents-md:update", "# Agents"],
    ["memoryUpdateIndexSections", "ave:memory:index:sections:update", { urgentMemory: "Keep this." }],
    ["memoryGetUserPrefs", "ave:memory:user-prefs:get"],
    ["memoryUpdateUserPrefs", "ave:memory:user-prefs:update", "# Preferences"],
    ["memoryRefreshUserPrefs", "ave:memory:user-prefs:refresh"],
    ["memoryRefreshLongTerm", "ave:memory:long-term:refresh"],
  ])("exposes %s and invokes %s", async (apiKey, channel, payload) => {
    const api = await loadAveApi();

    expect(typeof api[apiKey]).toBe("function");
    await (api[apiKey] as (value?: string) => Promise<unknown>)(payload);

    if (payload === undefined) {
      expect(mockInvoke).toHaveBeenCalledWith(channel);
    } else {
      expect(mockInvoke).toHaveBeenCalledWith(channel, payload);
    }
  });

  it("exposes memoryUpdateIndexIfUnchanged with expected and next content", async () => {
    const api = await loadAveApi();

    expect(typeof api["memoryUpdateIndexIfUnchanged"]).toBe("function");
    await (api["memoryUpdateIndexIfUnchanged"] as (expected: string, next: string) => Promise<unknown>)("# Old", "# New");

    expect(mockInvoke).toHaveBeenCalledWith("ave:memory:index:update-if-unchanged", "# Old", "# New");
  });
});

describe("preload — per-tile chat push filtering", () => {
  beforeEach(() => {
    vi.resetModules();
    exposed.clear();
    mockOn.mockClear();
    mockRemoveListener.mockClear();
  });

  async function subscribeOn(
    channel: string,
    subscribe: (surface: Record<string, unknown>) => () => void,
    chatGroupId?: string,
  ): Promise<{ listener: (event: unknown, payload: unknown) => void; unsubscribe: () => void }> {
    const { buildPublicSurface } = await import("../preload/public-surface.js");
    const root = buildPublicSurface() as Record<string, unknown>;
    const surface = chatGroupId === undefined
      ? root
      : (root["chatGroup"] as (id: string) => Record<string, unknown>)(chatGroupId);
    const unsubscribe = subscribe(surface);
    const call = mockOn.mock.calls.findLast((entry) => entry[0] === channel);
    return { listener: call?.[1] as (event: unknown, payload: unknown) => void, unsubscribe };
  }

  // Fallback banners and token streams must use the same tile filter.
  it.each([
    ["ave:chat:stream", "onChatStream"],
    ["ave:chat:fallback", "onChatFallback"],
  ])("%s reaches only the group it is addressed to", async (channel, apiKey) => {
    const handler = vi.fn();
    const { listener, unsubscribe } = await subscribeOn(
      channel,
      (surface) => (surface[apiKey] as (cb: (payload: unknown) => void) => () => void)(handler),
      "group-2",
    );

    const mine = { from: "a", to: "b", chatGroupId: "group-2" };
    listener({}, mine);
    listener({}, { from: "a", to: "b", chatGroupId: "group-3" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(mine);

    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(channel, listener);
  });

  // Unlabelled frames are producer errors; broadcasting them would leak conversations across tiles.
  it.each([
    ["ave:chat:stream", "onChatStream"],
    ["ave:chat:fallback", "onChatFallback"],
  ])("%s with no group label reaches no surface at all", async (channel, apiKey) => {
    const handler = vi.fn();
    const { listener } = await subscribeOn(
      channel,
      (surface) => (surface[apiKey] as (cb: (payload: unknown) => void) => () => void)(handler),
      "group-2",
    );

    listener({}, { from: "a", to: "b" });
    listener({}, { from: "a", to: "b", chatGroupId: null });
    listener({}, { from: "a", to: "b", chatGroupId: 2 });

    expect(handler).not.toHaveBeenCalled();
  });

  // The window surface receives only frames addressed to main.
  it.each([
    ["ave:chat:stream", "onChatStream"],
    ["ave:chat:fallback", "onChatFallback"],
  ])("%s reaches the root surface only when addressed to the primary tile", async (channel, apiKey) => {
    const handler = vi.fn();
    const { listener } = await subscribeOn(
      channel,
      (surface) => (surface[apiKey] as (cb: (payload: unknown) => void) => () => void)(handler),
    );

    const mine = { from: "a", to: "b", chatGroupId: MAIN_CHAT_GROUP_ID };
    listener({}, mine);
    listener({}, { from: "a", to: "b", chatGroupId: "group-2" });
    listener({}, { from: "a", to: "b" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(mine);
  });
});
