import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, PUBLIC_CHANNELS } from "../../contract/app-contract.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { securitySettingsGestures } from "../security-settings-gesture.js";
import { registerSkillMemoryHandlers } from "../domains/skill-memory.js";
import { requiredFixture } from "../../__tests__/support/required-fixture.js";
import type { SkillMemoryReviewState } from "../../shared/skill-memory-types.js";

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
  const ensureReviewAvailable = vi.fn<() => SkillMemoryReviewState>(() => "ready");
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
    expect(await f.invokeList(f.event)).toEqual({ ok: true, groups: [], review: "ready" });
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

  it("keeps listing and owner decisions available while automatic review is unavailable", async () => {
    const f = fixture();
    f.ensureReviewAvailable.mockReturnValueOnce("unavailable");
    expect(await f.invokeList(f.event)).toEqual({ ok: true, review: "unavailable", groups: [] });
    expect(f.listCurrent).toHaveBeenCalledOnce();
    const { lessonId, ...change } = f.change;
    for (const decision of [f.change, { ...f.change, action: "reject" }, { ...change, action: "undo", changeId: lessonId }]) {
      f.contents.emit("before-mouse-event", {}, { type: "mouseUp" });
      expect(await f.invokeDecision(f.event, decision)).toEqual({ ok: true });
    }
    expect(f.ensureReviewAvailable).toHaveBeenCalledOnce();
    expect(await f.invokeList(f.event)).toEqual({ ok: true, review: "ready", groups: [] });
  });

  it("refuses to list an unavailable store regardless of review state", async () => {
    const f = fixture();
    f.ensureReviewAvailable.mockReturnValue("ready");
    f.listCurrent.mockRejectedValue(new Error("Unreadable store"));
    expect(await f.invokeList(f.event)).toEqual({ ok: false });
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
