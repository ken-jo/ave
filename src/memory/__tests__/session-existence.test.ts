// The cheap existence predicate must agree with the actual conversation listing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SESSION_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SESSION_B = "bbbbbbbb-1111-2222-3333-444444444444";
const NEVER_WRITTEN = "cccccccc-1111-2222-3333-444444444444";

let dir: string;
let mm: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-session-existence-"));
  mm = new MemoryManager({ aveDir: dir });
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

function listedIds(): string[] {
  return mm.listSessions().map((entry) => entry.id).sort();
}

describe("hasSessionTranscript", () => {
  it("answers the same question listSessions answers", async () => {
    await mm.saveSession(SESSION_A, [{ role: "user", content: "first conversation" }]);
    await mm.saveSession(SESSION_B, [{ role: "user", content: "second conversation" }]);
    expect(listedIds()).toEqual([SESSION_A, SESSION_B]);

    for (const id of listedIds()) {
      expect(mm.hasSessionTranscript(id)).toBe(true);
    }
    expect(mm.hasSessionTranscript(NEVER_WRITTEN)).toBe(false);
  });

  it("stops claiming a conversation the moment its transcript is deleted", async () => {
    await mm.saveSession(SESSION_A, [{ role: "user", content: "about to be deleted" }]);
    await mm.saveSession(SESSION_B, [{ role: "user", content: "survives" }]);
    expect(mm.hasSessionTranscript(SESSION_A)).toBe(true);

    unlinkSync(join(dir, "sessions", `${SESSION_A}.jsonl`));

    expect(mm.hasSessionTranscript(SESSION_A)).toBe(false);
    expect(listedIds()).toEqual([SESSION_B]);
    expect(mm.hasSessionTranscript(SESSION_B)).toBe(true);
  });

  it("answers false for a malformed id instead of throwing at its caller", () => {
    // Snapshot projections return false for invalid ids instead of throwing.
    for (const malformed of ["", "not-a-uuid", "../escape", 42, null, undefined]) {
      expect(mm.hasSessionTranscript(malformed)).toBe(false);
    }
  });
});
