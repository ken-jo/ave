import { describe, expect, it, vi } from "vitest";
import {
  MemoryCaptureService,
  type MemoryCaptureReviewer,
} from "../memory-capture-service.js";
import type { MemoryManager, NoteEntry } from "../memory-manager.js";
import type { MemorySaveNotices } from "../memory-save-notices.js";
import { MAX_MEMORY_SOURCE_CHARS, MEMORY_KINDS, MemoryManager as RealMemoryManager } from "../memory-manager.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SOURCE = "I prefer concise status updates in Korean.";

function reviewedCapture(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    v: 1,
    action: "active",
    title: "Communication preference",
    content: "The user prefers concise status updates in Korean.",
    kind: "preference",
    evidence: "I prefer concise status updates in Korean.",
    confidence: 0.94,
    ...overrides,
  });
}

function makeMemoryManager() {
  const saved: NoteEntry[] = [];
  const saveMemory = vi.fn(async (
    title: string,
    content: string,
    options: Partial<NoteEntry> = {},
  ): Promise<{ op: "created"; entry: NoteEntry; fileDigest: string }> => {
    const entry: NoteEntry = {
      id: `memory-${saved.length + 1}`,
      filename: `memory-${saved.length + 1}.md`,
      title,
      content,
      updatedAt: "2026-08-02T00:00:00.000Z",
      ...options,
    };
    saved.push(entry);
    return { op: "created", entry, fileDigest: "f".repeat(64) };
  });
  return {
    manager: { saveMemory } as unknown as Pick<MemoryManager, "saveMemory">,
    saveMemory,
  };
}

function makeMemoryReviewer(raw = reviewedCapture()) {
  const review = vi.fn<MemoryCaptureReviewer["review"]>(async () => raw);
  return {
    memoryReviewer: { review } as MemoryCaptureReviewer,
    review,
  };
}

function enqueueTrustedAutomatic(service: MemoryCaptureService, input = SOURCE): void {
  service.enqueueAutomatic({
    sessionId: SESSION_ID,
    turnMessageId: TURN_MESSAGE_ID,
    input,
    inputOrigin: "user-keyboard",
    stopReason: "end_turn",
  });
}

function makeNotices() {
  return {
    saved: vi.fn<MemorySaveNotices["saved"]>(() => "11111111-2222-4333-8444-555555555555"),
    skipped: vi.fn<MemorySaveNotices["skipped"]>(),
  };
}

function createCaptureService(
  memoryManager: ConstructorParameters<typeof MemoryCaptureService>[0]["memoryManager"],
  memoryReviewer: MemoryCaptureReviewer,
  notices = makeNotices(),
) {
  return new MemoryCaptureService({ memoryManager, memoryReviewer, notices, sessionStore: "main" });
}

const SESSION_ID = "0b6f3f43-3c5e-4f5f-9a51-2b0b6c1e9d10";
const TURN_MESSAGE_ID = "7d1c2a4e-9f0b-4c3d-8e6f-5a4b3c2d1e0f";

describe("MemoryCaptureService", () => {
  it("host-validates a trusted automatic capture before saving it as active", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer, review } = makeMemoryReviewer();
    const service = new MemoryCaptureService({
      memoryManager: manager,
      notices: makeNotices(),
      sessionStore: "main",
    });
    service.setMemoryReviewer(memoryReviewer);

    enqueueTrustedAutomatic(service);
    await service.runOnIdle();

    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(
      "capture",
      expect.stringContaining(SOURCE),
      expect.objectContaining({
        signal: expect.anything(),
        systemPrompt: "Return exactly the requested JSON object and nothing else.",
      }),
    );
    expect(saveMemory).toHaveBeenCalledWith(
      "Communication preference",
      "The user prefers concise status updates in Korean.",
      expect.objectContaining({
        kind: "preference",
        source: "capture",
        capture: expect.objectContaining({
          v: 1,
          method: "llm-refined",
          trigger: "automatic",
          sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        origin: { v: 1, sessionId: SESSION_ID, messageId: TURN_MESSAGE_ID, store: "main" },
      }), "capture",
    );
  });

  it("records the conversation an explicit save came from, and nothing for a direct UI save", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer } = makeMemoryReviewer();
    const service = createCaptureService(manager, memoryReviewer);

    await service.captureExplicit({ title: "Status preference", content: SOURCE, sessionId: SESSION_ID });
    await service.captureExplicit({ title: "Status preference", content: SOURCE });

    expect(saveMemory.mock.calls[0]![2]).toMatchObject({ origin: { v: 1, sessionId: SESSION_ID, store: "main" } });
    expect(saveMemory.mock.calls[0]![2]!.origin).not.toHaveProperty("messageId");
    expect(saveMemory.mock.calls[1]![2]).not.toHaveProperty("origin");
  });

  it("returns what it saved, and a reviewer skip saves nothing", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const saved = await createCaptureService(manager, makeMemoryReviewer().memoryReviewer)
      .captureExplicit({ title: "Status preference", content: SOURCE });
    expect(saved).toMatchObject({ status: "saved", op: "created", entry: { title: "Communication preference" } });

    const skip = reviewedCapture({ action: "skip", title: "", content: "", kind: "", evidence: "", confidence: 0 });
    const skipped = await createCaptureService(manager, makeMemoryReviewer(skip).memoryReviewer)
      .captureExplicit({ title: "Status preference", content: SOURCE });
    expect(skipped).toEqual({ status: "skipped", reason: "reviewer-skip" });
    expect(saveMemory).toHaveBeenCalledTimes(1);
  });

  it("refuses the retired candidate action from the reviewer", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const service = createCaptureService(manager, makeMemoryReviewer(reviewedCapture({ action: "candidate" })).memoryReviewer);
    const result = await service.captureExplicit({ title: "Status preference", content: SOURCE });
    expect(result.status).toBe("skipped");
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it("rejects tainted automatic turns before any model or storage call", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer, review } = makeMemoryReviewer();
    const service = createCaptureService(manager, memoryReviewer);

    service.enqueueAutomatic({
      sessionId: "session-1",
      input: SOURCE,
      inputOrigin: "user-keyboard",
      stopReason: "end_turn",
      taintReasons: ["attachment"],
    });
    await service.runOnIdle();

    expect(review).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it("never falls back to raw automatic input after an invalid reviewer result", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer } = makeMemoryReviewer("not json");
    const service = createCaptureService(manager, memoryReviewer);

    enqueueTrustedAutomatic(service);
    await service.runOnIdle();

    expect(saveMemory).not.toHaveBeenCalled();
  });


  it("runs explicit user saves through the same reviewer", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer, review } = makeMemoryReviewer();
    const service = createCaptureService(manager, memoryReviewer);

    const result = await service.captureExplicit({
      title: "Status preference",
      content: SOURCE,
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });

    expect(result.status).toBe("saved");
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(
      "capture",
      expect.stringContaining(SOURCE),
      expect.any(Object),
    );
    expect(saveMemory).toHaveBeenCalledWith(
      "Communication preference",
      "The user prefers concise status updates in Korean.",
      expect.objectContaining({
        source: "user",
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
        capture: expect.objectContaining({ trigger: "explicit" }),
      }), "user",
    );
  });

  it("does not send explicit sensitive input to the reviewer", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer, review } = makeMemoryReviewer();
    const service = createCaptureService(manager, memoryReviewer);

    const result = await service.captureExplicit({
      content: "api_key=sk-abcdefghijklmnopqrst",
    });

    expect(result).toEqual({ status: "skipped", reason: "sensitive-input" });
    expect(review).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });
});

describe("MemoryCaptureService notices", () => {
  it("announces an automatic save under the user row that taught it, with an undo token", async () => {
    const { manager } = makeMemoryManager();
    const notices = makeNotices();
    const service = createCaptureService(manager, makeMemoryReviewer().memoryReviewer, notices);

    enqueueTrustedAutomatic(service);
    await service.runOnIdle();

    expect(notices.saved).toHaveBeenCalledWith(
      { sessionId: SESSION_ID, anchorMessageId: TURN_MESSAGE_ID },
      expect.objectContaining({ op: "created", entry: expect.objectContaining({ title: "Communication preference" }), fileDigest: "f".repeat(64) }),
    );
  });

  it("returns the undo token for /remember and announces in its conversation", async () => {
    const { manager } = makeMemoryManager();
    const notices = makeNotices();
    const result = await createCaptureService(manager, makeMemoryReviewer().memoryReviewer, notices)
      .captureExplicit({ title: "Status preference", content: SOURCE, sessionId: SESSION_ID });

    expect(result).toMatchObject({ status: "saved", undoToken: "11111111-2222-4333-8444-555555555555" });
    expect(notices.saved).toHaveBeenCalledWith({ sessionId: SESSION_ID }, expect.objectContaining({ op: "created", fileDigest: "f".repeat(64) }));
  });

  it("anchors /remember's notice under the command's row without persisting that row id", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const notices = makeNotices();
    await createCaptureService(manager, makeMemoryReviewer().memoryReviewer, notices)
      .captureExplicit({ title: "Status preference", content: SOURCE, sessionId: SESSION_ID, anchorMessageId: TURN_MESSAGE_ID });

    expect(notices.saved).toHaveBeenCalledWith({ sessionId: SESSION_ID, anchorMessageId: TURN_MESSAGE_ID }, expect.anything());
    const options = saveMemory.mock.calls[0]![2] as { origin?: { messageId?: string } };
    expect(options.origin).toEqual(expect.objectContaining({ sessionId: SESSION_ID }));
    expect(options.origin?.messageId).toBeUndefined();
  });

  it("tells /remember's conversation why it did not save, and stays silent for automatic skips", async () => {
    const { manager } = makeMemoryManager();
    const notices = makeNotices();
    const service = createCaptureService(manager, makeMemoryReviewer().memoryReviewer, notices);

    await service.captureExplicit({ content: "api_key=sk-abcdefghijklmnopqrst", sessionId: SESSION_ID });
    expect(notices.skipped).toHaveBeenCalledWith({ sessionId: SESSION_ID }, "sensitive-input");

    const failing = createCaptureService(manager, { review: vi.fn(async () => "not json") } as MemoryCaptureReviewer, notices);
    await failing.captureExplicit({ content: SOURCE, sessionId: SESSION_ID });
    expect(notices.skipped).toHaveBeenLastCalledWith({ sessionId: SESSION_ID }, "invalid-review");

    const skip = reviewedCapture({ action: "skip", title: "", content: "", kind: "", evidence: "", confidence: 0 });
    await createCaptureService(manager, makeMemoryReviewer(skip).memoryReviewer, notices).captureExplicit({ content: SOURCE, sessionId: SESSION_ID });
    expect(notices.skipped).toHaveBeenLastCalledWith({ sessionId: SESSION_ID }, "reviewer-skip");

    notices.skipped.mockClear();
    service.enqueueAutomatic({ sessionId: SESSION_ID, input: SOURCE, inputOrigin: "user-keyboard", stopReason: "end_turn", taintReasons: ["attachment"] });
    await failing.runOnIdle();
    enqueueTrustedAutomatic(failing);
    await failing.runOnIdle();
    expect(notices.skipped).not.toHaveBeenCalled();
  });

  it("reports a refused write to /remember's conversation and still throws", async () => {
    const saveMemory = vi.fn(async () => { throw new Error("saveMemory: unsafe-text: zero-width and bidi control characters are not allowed"); });
    const notices = makeNotices();
    const service = createCaptureService({ saveMemory } as never, makeMemoryReviewer().memoryReviewer, notices);
    await expect(service.captureExplicit({ content: SOURCE, sessionId: SESSION_ID })).rejects.toThrow(/unsafe-text/);
    expect(notices.skipped).toHaveBeenCalledWith({ sessionId: SESSION_ID }, "unsafe-text");
  });
});

describe("MemoryCaptureService with the real store", () => {
  it("persists where an automatic capture was learned and reads it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-capture-origin-"));
    const store = new RealMemoryManager({ aveDir: dir });
    try {
      const { memoryReviewer } = makeMemoryReviewer();
      const service = createCaptureService(store, memoryReviewer);

      enqueueTrustedAutomatic(service);
      await service.runOnIdle();

      const saved = store.listMemoryEntries().find((entry) => entry.title === "Communication preference");
      expect(saved?.origin).toEqual({ v: 1, sessionId: SESSION_ID, messageId: TURN_MESSAGE_ID, store: "main" });
    } finally {
      store.stopPersistentContextWatcher();
      store.closeSearchIndex();
      await cleanupTmpDir(dir);
    }
  });
});

describe("memory domain constants", () => {
  it("expose the six memory kinds and the source-text bound the capture and consolidation services share", () => {
    expect([...MEMORY_KINDS].sort()).toEqual(["constraint", "fact", "goal", "note", "preference", "reference"]);
    expect(MAX_MEMORY_SOURCE_CHARS).toBe(4_000);
  });
});
