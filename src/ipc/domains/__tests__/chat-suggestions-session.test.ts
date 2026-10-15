/**
 * The conversation-row actions on the dedicated Suggestions conversation.
 *
 * Every unrequested card waiting in the window names that conversation as its
 * origin, and a card addressed to a conversation the list does not hold is
 * drawn nowhere. So the two row actions that would take it out of the list
 * are held here, in main, where the user's confirm also lives:
 *
 *  - delete CLEARS it: the transcript goes and an empty one is created in the
 *    same handler, so the row is listed again before the renderer re-reads the
 *    list and no waiting card is stranded (a plugin card lives only in the
 *    renderer, which main cannot see — so this does not depend on asking it);
 *  - archive is refused, because the sidebar hides archived rows and every
 *    future suggestion, with its count, would be hidden with it.
 *
 * Driven through the real registered handlers against a real MemoryManager.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeRegisteredHandler } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { SUGGESTIONS_SESSION_ID } from "../../../shared/suggestions-session.js";

const DELETE = "ave:chat:session-delete";
const UPDATE = "ave:chat:session-update";
const ORDINARY = "6b2a1c3d-1111-4222-8333-444455556666";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const showMessageBox = vi.fn(async () => ({ response: 1 }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: (...args: unknown[]) => showMessageBox(...(args as [])),
  },
}));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

let dir: string;
let mm: MemoryManager;

async function register(): Promise<void> {
  handlers.clear();
  const { registerChatHandlers } = await import("../chat.js");
  registerChatHandlers({
    conversationLoop: {
      getHistory: vi.fn(() => ({ getMessages: () => [], truncate: vi.fn(), restore: vi.fn() })),
      // The primary tile holds some other conversation: these deletes are of
      // conversations no tile has loaded.
      getSessionId: vi.fn(() => "active-session"),
      getSessionKind: vi.fn(() => "main"),
      loadSession: vi.fn(() => true),
    },
    settingsService: { get: vi.fn(() => ({})), patch: vi.fn(async () => undefined) },
    memoryManager: mm,
    auditLogger: { log: vi.fn() },
    getMainWindow: vi.fn(() => null),
  } as never);
}

const listed = (id: string) => mm.listSessions().some((session) => session.id === id);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ave-chat-suggestions-"));
  mm = new MemoryManager({ aveDir: dir });
  showMessageBox.mockClear();
  showMessageBox.mockResolvedValue({ response: 1 });
  await register();
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("deleting the Suggestions conversation", () => {
  it("clears its history and lists it again at once, empty", async () => {
    await mm.saveSession(SUGGESTIONS_SESSION_ID, [
      { role: "user", content: "an accepted suggestion" },
      { role: "assistant", content: "its answer" },
    ]);

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; wasLoaded?: boolean }>>(
      handlers, DELETE, { sessionId: SUGGESTIONS_SESSION_ID },
    );

    expect(result).toEqual({ ok: true, wasLoaded: false });
    // The address every waiting card names is still in the list.
    expect(listed(SUGGESTIONS_SESSION_ID)).toBe(true);
    expect(mm.loadSession(SUGGESTIONS_SESSION_ID)).toEqual([]);
  });

  it("leaves it untouched when the user cancels the confirm", async () => {
    await mm.saveSession(SUGGESTIONS_SESSION_ID, [{ role: "user", content: "kept" }]);
    showMessageBox.mockResolvedValue({ response: 0 });

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; canceled?: boolean }>>(
      handlers, DELETE, { sessionId: SUGGESTIONS_SESSION_ID },
    );

    expect(result).toEqual({ ok: false, canceled: true });
    expect(mm.loadSession(SUGGESTIONS_SESSION_ID)).toEqual([
      expect.objectContaining({ role: "user", content: "kept" }),
    ]);
  });

  it("removes an ordinary conversation for good", async () => {
    await mm.saveSession(ORDINARY, [{ role: "user", content: "mine" }]);

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(
      handlers, DELETE, { sessionId: ORDINARY },
    );

    expect(result.ok).toBe(true);
    expect(listed(ORDINARY)).toBe(false);
    expect(listed(SUGGESTIONS_SESSION_ID)).toBe(false);
  });
});

describe("archiving the Suggestions conversation", () => {
  it("is refused, and the row stays unarchived", async () => {
    mm.touchSessionTranscript(SUGGESTIONS_SESSION_ID, { bump: false });

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, UPDATE, { sessionId: SUGGESTIONS_SESSION_ID, archived: true },
    );

    expect(result).toEqual({ ok: false, error: "suggestions-not-archivable" });
    const row = mm.listSessions().find((session) => session.id === SUGGESTIONS_SESSION_ID);
    expect(row?.archivedAt).toBeFalsy();
  });

  it("still archives an ordinary conversation", async () => {
    await mm.saveSession(ORDINARY, [{ role: "user", content: "mine" }]);

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(
      handlers, UPDATE, { sessionId: ORDINARY, archived: true },
    );

    expect(result).toEqual({ ok: true });
    const row = mm.listSessions().find((session) => session.id === ORDINARY);
    expect(row?.archivedAt).toBeTruthy();
  });
});
