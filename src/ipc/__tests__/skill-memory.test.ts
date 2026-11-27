import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, PUBLIC_CHANNELS } from "../../contract/app-contract.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { securitySettingsGestures } from "../security-settings-gesture.js";
import { registerSkillMemoryHandlers } from "../domains/skill-memory.js";
import { requiredFixture } from "../../__tests__/support/required-fixture.js";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  focused: true,
  current: true,
}));
vi.mock("electron", () => ({ ipcMain: { handle: (key: string, handle: (...args: unknown[]) => unknown) => state.handlers.set(key, handle) } }));
vi.mock("../../main/app-state.js", () => ({ mainWindowForContents: () => ({ isFocused: () => state.focused }) }));
vi.mock("../../main/project-root-authorization.js", () => ({ isAuthorizedWorkspaceProjectRoot: () => true }));
vi.mock("../../memory/skill-memory-service.js", () => ({ isSkillMemoryProposalCurrent: () => state.current }));

beforeEach(() => {
  state.handlers.clear();
  state.focused = true;
  state.current = true;
});

function fixture() {
  const frame = { url: "file:///renderer.html" };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
  securitySettingsGestures.observe(contents as never);
  const event = { sender: contents, senderFrame: frame };
  const list = vi.fn(() => []);
  const listCurrent = vi.fn(async () => []);
  const decide = vi.fn(async (_input: unknown, grant: (scope: object, lesson: object) => boolean) => grant({}, {}));
  const ensureReviewAvailable = vi.fn(async () => true);
  registerSkillMemoryHandlers({
    conversationLoop: { deps: { skillMemory: { ensureReviewAvailable, store: { list, listCurrent, decide } } } }, auditLogger: { log: vi.fn() },
  } as never);
  const change = {
    scopeId: sha256Hex("scope"), action: "apply", lessonId: "7c1c6b6e-1b53-4b47-b6ec-9b9ea567c8fe", digest: sha256Hex("lesson"),
  };
  return {
    contents, event, listCurrent, decide, change, ensureReviewAvailable,
    invokeList: (...args: unknown[]) => requiredFixture(state.handlers.get(CHANNELS.skillMemory.list))(...args),
    invokeDecision: (...args: unknown[]) => requiredFixture(state.handlers.get(CHANNELS.skillMemory.decide))(...args),
  };
}

describe("skill memory IPC", () => {
  it("keeps the channels internal and refuses non-owner frames", async () => {
    const f = fixture();
    expect(PUBLIC_CHANNELS).not.toContain(CHANNELS.skillMemory.list);
    expect(PUBLIC_CHANNELS).not.toContain(CHANNELS.skillMemory.decide);
    expect(await f.invokeList({ ...f.event, senderFrame: { ...f.event.senderFrame } })).toMatchObject({ error: "unauthorized-frame" });
    expect(f.listCurrent).not.toHaveBeenCalled();
    state.focused = false;
    expect(await f.invokeList(f.event)).toEqual({ ok: true, groups: [] });
    expect(await f.invokeDecision(f.event, f.change)).toMatchObject({ error: "unauthorized-frame" });
  });

  it("requires and consumes a live, one-shot native decision", async () => {
    const f = fixture();
    expect(await f.invokeDecision(f.event, f.change)).toEqual({ ok: false });
    expect(f.decide).not.toHaveBeenCalled();
    f.contents.emit("before-mouse-event", {}, { type: "mouseUp" });
    expect(await f.invokeDecision(f.event, f.change)).toEqual({ ok: true });
    expect(await f.invokeDecision(f.event, f.change)).toEqual({ ok: false });
  });

  it("reports unavailable review through the existing list response and can recover on retry", async () => {
    const f = fixture();
    f.ensureReviewAvailable.mockResolvedValueOnce(false);
    expect(await f.invokeList(f.event)).toEqual({ ok: false });
    expect(f.listCurrent).not.toHaveBeenCalled();
    expect(await f.invokeList(f.event)).toEqual({ ok: true, groups: [] });
  });

  it("refuses stale sources and unknown decision fields", async () => {
    const f = fixture();
    f.contents.emit("before-mouse-event", {}, { type: "mouseUp" });
    expect(await f.invokeDecision(f.event, { ...f.change, body: "new content" })).toEqual({ ok: false });
    expect(f.decide).not.toHaveBeenCalled();
    state.current = false;
    expect(await f.invokeDecision(f.event, f.change)).toEqual({ ok: false });
    expect(f.decide).toHaveBeenCalledOnce();
  });
});
