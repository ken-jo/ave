/**
 * The dedicated Suggestions conversation exists before anything is addressed
 * to it.
 *
 * Main makes it exist synchronously as it stages a suggestion, so the row is
 * listed by the time the renderer re-reads the list. It is an ordinary `main`
 * conversation: created empty, never replacing a transcript the user already
 * has there, and moved up the recency-ordered list only when something new
 * arrives — not when a window merely pulls cards staged earlier.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../../memory/memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { SUGGESTIONS_SESSION_ID } from "../../shared/suggestions-session.js";
import { ensureSuggestionsSession, stageInSuggestionsSession } from "../suggestions-session.js";
import { handleChatSessionHistory } from "../../ipc/handlers/chat.js";
import { t } from "../../i18n/index.js";

let dir: string;
let mm: MemoryManager;

const transcript = () => join(mm.getDir(), "sessions", `${SUGGESTIONS_SESSION_ID}.jsonl`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-suggestions-session-"));
  mm = new MemoryManager({ aveDir: dir });
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("the dedicated Suggestions conversation", () => {
  it("is created on demand as an empty, listed main conversation, named once", async () => {
    expect(mm.hasSessionTranscript(SUGGESTIONS_SESSION_ID)).toBe(false);
    stageInSuggestionsSession(mm);
    expect(mm.loadSession(SUGGESTIONS_SESSION_ID)).toEqual([]);
    const row = mm.listSessions().find((session) => session.id === SUGGESTIONS_SESSION_ID);
    expect(row?.sessionKind).toBe("main");
    await vi.waitFor(() => expect(mm.loadSessionMetadata(SUGGESTIONS_SESSION_ID)?.title).toBe(t("be_suggestionsSession.title")));

    // A rename by the user sticks: later suggestions do not rename it back.
    await mm.updateSessionRowFields(SUGGESTIONS_SESSION_ID, { title: "Inbox" });
    stageInSuggestionsSession(mm);
    ensureSuggestionsSession(mm);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mm.loadSessionMetadata(SUGGESTIONS_SESSION_ID)?.title).toBe("Inbox");
  });

  it("opens through the real session-history read, with no metadata yet", async () => {
    mm.touchSessionTranscript(SUGGESTIONS_SESSION_ID, { bump: false });
    const history = handleChatSessionHistory({ memoryManager: mm } as never, SUGGESTIONS_SESSION_ID);
    expect(history).toMatchObject({ ok: true, sessionKind: "main", messages: [] });
  });

  it("never replaces a transcript the user already has there", async () => {
    await mm.saveSession(SUGGESTIONS_SESSION_ID, [{ role: "user", content: "kept" }]);
    stageInSuggestionsSession(mm);
    ensureSuggestionsSession(mm);
    expect(mm.loadSession(SUGGESTIONS_SESSION_ID)).toEqual([
      expect.objectContaining({ role: "user", content: "kept" }),
    ]);
  });

  it("rises in the list when a suggestion arrives, and stays put on a snapshot pull", () => {
    ensureSuggestionsSession(mm);
    const past = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(transcript(), past, past);

    ensureSuggestionsSession(mm);
    expect(statSync(transcript()).mtime.getTime()).toBe(past.getTime());

    stageInSuggestionsSession(mm);
    expect(statSync(transcript()).mtime.getTime()).toBeGreaterThan(past.getTime());
  });

  it("refuses an id that is not a session id", () => {
    expect(() => mm.touchSessionTranscript("../escape", { bump: true })).toThrow(/invalid sessionId/);
  });
});
