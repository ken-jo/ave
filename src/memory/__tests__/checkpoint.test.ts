import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidSessionId, MemoryManager } from "../memory-manager.js";
import type { Checkpoint, SessionMetadata } from "../memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

function makeCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint {
  return {
    id: "ckpt-0001",
    triggeredAt: "2026-05-01T10:00:00.000Z",
    trigger: "auto-compact",
    ctxUsageAtTrigger: 0.85,
    summary: "We discussed the quarterly review.",
    messageCountAtTrigger: 40,
    ...overrides,
  };
}

const SESSION_A = "aaaaaaaa-0000-1111-2222-333333333333";
const SESSION_B = "bbbbbbbb-0000-1111-2222-333333333333";
const SESSION_C = "cccccccc-0000-1111-2222-333333333333";

let dir: string;
let mm: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-ckpt-"));
  mm = new MemoryManager({ aveDir: dir });
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

function writeSessionMetadataFixture(sessionsDir: string, sessionId: string, metadata: unknown) {
  writeFileSync(join(sessionsDir, `${sessionId}.meta.json`), JSON.stringify(metadata), "utf-8");
}

describe("appendCheckpoint", () => {
  it("adds a checkpoint to metadata with no prior checkpoints", () => {
    const meta: SessionMetadata = { sessionKind: "routine", routineId: "r1" };
    const ckpt = makeCheckpoint();
    const updated = mm.appendCheckpoint(meta, ckpt);
    expect(updated.checkpoints).toHaveLength(1);
    expect(updated.checkpoints![0]).toEqual(ckpt);
  });

  it("preserves existing checkpoints when appending a new one", () => {
    const first = makeCheckpoint({ id: "ckpt-0001", messageCountAtTrigger: 20 });
    const second = makeCheckpoint({ id: "ckpt-0002", messageCountAtTrigger: 60, trigger: "auto-compact" });
    const meta: SessionMetadata = { checkpoints: [first] };
    const updated = mm.appendCheckpoint(meta, second);
    expect(updated.checkpoints).toHaveLength(2);
    expect(updated.checkpoints![0]).toEqual(first);
    expect(updated.checkpoints![1]).toEqual(second);
  });

  it("does not mutate the original metadata object", () => {
    const meta: SessionMetadata = { checkpoints: [makeCheckpoint()] };
    const original = JSON.stringify(meta);
    mm.appendCheckpoint(meta, makeCheckpoint({ id: "ckpt-new" }));
    expect(JSON.stringify(meta)).toBe(original);
  });

  it("persists checkpoints correctly through saveSessionMetadata + loadSessionMetadata", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);
    const ckpt = makeCheckpoint();
    const meta: SessionMetadata = { sessionKind: "routine", routineId: "r1" };
    const updated = mm.appendCheckpoint(meta, ckpt);
    await mm.saveSessionMetadata(sessionId, updated);

    const loaded = mm.loadSessionMetadata(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpoints).toHaveLength(1);
    expect(loaded!.checkpoints![0].id).toBe("ckpt-0001");
    expect(loaded!.checkpoints![0].trigger).toBe("auto-compact");
    expect(loaded!.checkpoints![0].summary).toBe("We discussed the quarterly review.");
  });
});

describe("project metadata", () => {
  it("persists project identity and filters session lists by projectRoot", async () => {
    await mm.saveSession(SESSION_A, [{ role: "user", content: "project a" }]);
    await mm.saveSession(SESSION_B, [{ role: "user", content: "project b" }]);
    await mm.saveSessionMetadata(SESSION_A, {
      sessionKind: "main",
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    await mm.saveSessionMetadata(SESSION_B, {
      sessionKind: "main",
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
    });

    expect(mm.loadSessionMetadata(SESSION_A)).toMatchObject({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(mm.listSessionsPage({ kind: "main", projectRoot: "c:/workspace/alpha/" }).map((s) => s.id))
      .toEqual([SESSION_A]);
  });

  it("can include legacy unscoped sessions when listing the default project", async () => {
    await mm.saveSession(SESSION_A, [{ role: "user", content: "legacy" }]);
    await mm.saveSession(SESSION_B, [{ role: "user", content: "project b" }]);
    await mm.saveSessionMetadata(SESSION_B, {
      sessionKind: "main",
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
    });

    expect(mm.listSessionsPage({
      kind: "main",
      projectRoot: "C:\\workspace\\default",
      includeUnscoped: true,
    }).map((s) => s.id)).toEqual([SESSION_A]);
  });
});

describe("setSummaryPreamble", () => {
  it("stores the preamble in metadata", () => {
    const meta: SessionMetadata = {};
    const updated = mm.setSummaryPreamble(meta, "Summary of prior discussion.");
    expect(updated.summaryPreamble).toBe("Summary of prior discussion.");
  });

  it("replaces an existing preamble", () => {
    const meta: SessionMetadata = { summaryPreamble: "old preamble" };
    const updated = mm.setSummaryPreamble(meta, "new preamble");
    expect(updated.summaryPreamble).toBe("new preamble");
  });

  it("truncates preamble exceeding 8000 chars", () => {
    const long = "x".repeat(10_000);
    const updated = mm.setSummaryPreamble({}, long);
    expect(updated.summaryPreamble!.length).toBe(8_000);
  });

  it("does not truncate preamble at exactly 8000 chars", () => {
    const exact = "y".repeat(8_000);
    const updated = mm.setSummaryPreamble({}, exact);
    expect(updated.summaryPreamble!.length).toBe(8_000);
  });

  it("does not mutate the original metadata object", () => {
    const meta: SessionMetadata = { summaryPreamble: "original" };
    mm.setSummaryPreamble(meta, "new value");
    expect(meta.summaryPreamble).toBe("original");
  });

  it("persists and loads preamble round-trip", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);
    const updated = mm.setSummaryPreamble({}, "context from previous session");
    await mm.saveSessionMetadata(sessionId, updated);

    const loaded = mm.loadSessionMetadata(sessionId);
    expect(loaded!.summaryPreamble).toBe("context from previous session");
  });
});

describe("metadata validation", () => {
  it("silently drops checkpoint entries with invalid trigger values", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeSessionMetadataFixture(sessionsDir, sessionId, {
        checkpoints: [
          {
            id: "ckpt-valid",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: 0.9,
            summary: null,
            messageCountAtTrigger: 30,
          },
          {
            id: "ckpt-invalid",
            triggeredAt: "2026-05-01T11:00:00.000Z",
            trigger: "unknown-trigger",  // invalid
            ctxUsageAtTrigger: 0.5,
            summary: null,
            messageCountAtTrigger: 50,
          },
        ],
      });

    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toHaveLength(1);
    expect(meta!.checkpoints![0].id).toBe("ckpt-valid");
  });
});

describe("main active session state", () => {
  it("persists resume state for an explicit main session", async () => {
    await mm.saveSession(SESSION_A, [{ role: "user", content: "main" }]);
    await mm.saveSessionMetadata(SESSION_A, { sessionKind: "main" });

    await mm.markMainActiveResume(SESSION_A);

    expect(mm.loadMainActiveSessionState()).toEqual({
      mainActiveMode: "resume",
      mainActiveSessionId: SESSION_A,
      updatedAt: expect.any(String),
    });
  });

  it("fresh mode ignores any stored session id", async () => {
    await mm.saveMainActiveSessionState({
      mainActiveMode: "fresh",
      mainActiveSessionId: SESSION_A,
      updatedAt: "2026-05-16T00:00:00.000Z",
    });

    expect(mm.loadMainActiveSessionState()).toEqual({
      mainActiveMode: "fresh",
      mainActiveSessionId: null,
      updatedAt: "2026-05-16T00:00:00.000Z",
    });
  });

  it("treats a routine session id in active state as fresh", async () => {
    await mm.saveSession(SESSION_B, [{ role: "user", content: "routine" }]);
    await mm.saveSessionMetadata(SESSION_B, {
      sessionKind: "routine",
      routineId: "r1",
      routineTitle: "Routine",
    });
    const sessionsDir = join(dir, "sessions");
    writeFileSync(
      join(sessionsDir, ".active-session.json"),
      JSON.stringify({
        mainActiveMode: "resume",
        mainActiveSessionId: SESSION_B,
        updatedAt: "2026-05-16T00:00:00.000Z",
      }),
      "utf-8",
    );

    expect(mm.loadMainActiveSessionState()).toEqual({
      mainActiveMode: "fresh",
      mainActiveSessionId: null,
      updatedAt: "2026-05-16T00:00:00.000Z",
    });
  });

  it("returns null for corrupt active state files", async () => {
    const sessionsDir = join(dir, "sessions");
    writeFileSync(join(sessionsDir, ".active-session.json"), "{", "utf-8");

    expect(mm.loadMainActiveSessionState()).toBeNull();
  });
});

describe("normalizeCheckpoint range validation", () => {
  it("drops checkpoint with ctxUsageAtTrigger below 0", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeSessionMetadataFixture(sessionsDir, sessionId, {
        checkpoints: [
          {
            id: "ckpt-neg-ctx",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: -0.5,
            summary: null,
            messageCountAtTrigger: 10,
          },
        ],
      });
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toBeUndefined();
  });

  it("drops checkpoint with ctxUsageAtTrigger above 1", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeSessionMetadataFixture(sessionsDir, sessionId, {
        checkpoints: [
          {
            id: "ckpt-over-ctx",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: 1.5,
            summary: null,
            messageCountAtTrigger: 10,
          },
        ],
      });
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toBeUndefined();
  });

  it("drops checkpoint with ctxUsageAtTrigger = NaN", async () => {
    const sessionId = SESSION_C;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    // JSON encodes NaN as null; use null to exercise that persisted shape.
    writeSessionMetadataFixture(sessionsDir, sessionId, {
        checkpoints: [
          {
            id: "ckpt-nan-ctx",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: null,
            summary: null,
            messageCountAtTrigger: 10,
          },
        ],
      });
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toBeUndefined();
  });

  it("drops checkpoint with negative messageCountAtTrigger", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeSessionMetadataFixture(sessionsDir, sessionId, {
        checkpoints: [
          {
            id: "ckpt-neg-msg",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: 0.5,
            summary: null,
            messageCountAtTrigger: -1,
          },
        ],
      });
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toBeUndefined();
  });

  it("drops checkpoint with fractional messageCountAtTrigger", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeSessionMetadataFixture(sessionsDir, sessionId, {
        checkpoints: [
          {
            id: "ckpt-float-msg",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: 0.5,
            summary: null,
            messageCountAtTrigger: 1.5,
          },
        ],
      });
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toBeUndefined();
  });
});

describe("normalizeSessionMetadata — parentSessionId regex validation", () => {
  it("drops parentSessionId with path-traversal characters during normalize", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeSessionMetadataFixture(sessionsDir, sessionId, { sessionKind: "routine", routineId: "r1", parentSessionId: "../../../etc/passwd" });
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta).not.toBeNull();
    expect(meta!.routineId).toBe("r1");
    expect(meta!.parentSessionId).toBeUndefined();
  });

  it("preserves a valid parentSessionId through normalize", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeSessionMetadataFixture(sessionsDir, sessionId, { parentSessionId: SESSION_A });
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.parentSessionId).toBe(SESSION_A);
  });
});

describe("saveSessionMetadata — summaryPreamble truncation invariant", () => {
  it("truncates summaryPreamble exceeding 8000 chars even when setSummaryPreamble was bypassed", async () => {
    const sessionId = SESSION_C;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);
    const overlong = "z".repeat(12_000);
    await mm.saveSessionMetadata(sessionId, { summaryPreamble: overlong });

    const loaded = mm.loadSessionMetadata(sessionId);
    expect(loaded!.summaryPreamble!.length).toBe(8_000);
  });

  it("does not mutate original metadata passed to saveSessionMetadata", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);
    const overlong = "z".repeat(12_000);
    const original: SessionMetadata = { summaryPreamble: overlong };
    await mm.saveSessionMetadata(sessionId, original);
    expect(original.summaryPreamble!.length).toBe(12_000);
  });

  it("does not alter summaryPreamble that is exactly at the limit", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);
    const exact = "a".repeat(8_000);
    await mm.saveSessionMetadata(sessionId, { summaryPreamble: exact });
    const loaded = mm.loadSessionMetadata(sessionId);
    expect(loaded!.summaryPreamble!.length).toBe(8_000);
  });
});

describe("isValidSessionId helper — valid/invalid boundaries", () => {
  it("accepts a standard UUID-format parentSessionId", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_A, [{ role: "user", content: "msg" }]);
    writeSessionMetadataFixture(sessionsDir, SESSION_A, { parentSessionId: SESSION_B });
    const meta = mm.loadSessionMetadata(SESSION_A);
    expect(meta!.parentSessionId).toBe(SESSION_B);
  });

  it("accepts alphanumeric-plus-dash ID (non-UUID-shaped)", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_A, [{ role: "user", content: "msg" }]);
    writeSessionMetadataFixture(sessionsDir, SESSION_A, { parentSessionId: "f502abaa-afc9-46a6-863c-19c8bbe6013c" });
    const meta = mm.loadSessionMetadata(SESSION_A);
    expect(meta!.parentSessionId).toBe("f502abaa-afc9-46a6-863c-19c8bbe6013c");
  });

  it("rejects parentSessionId with slash (path-traversal)", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_A, [{ role: "user", content: "msg" }]);
    writeSessionMetadataFixture(sessionsDir, SESSION_A, { parentSessionId: "../evil" });
    const meta = mm.loadSessionMetadata(SESSION_A);
    expect(meta!.parentSessionId).toBeUndefined();
  });

  it("rejects parentSessionId with space", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_B, [{ role: "user", content: "msg" }]);
    writeSessionMetadataFixture(sessionsDir, SESSION_B, { parentSessionId: "session id" });
    const meta = mm.loadSessionMetadata(SESSION_B);
    expect(meta!.parentSessionId).toBeUndefined();
  });

  it("rejects empty string parentSessionId", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_C, [{ role: "user", content: "msg" }]);
    writeSessionMetadataFixture(sessionsDir, SESSION_C, { parentSessionId: "" });
    const meta = mm.loadSessionMetadata(SESSION_C);
    expect(meta!.parentSessionId).toBeUndefined();
  });
});

describe("normalizeSessionMetadata — read-side summaryPreamble truncation (defense-in-depth)", () => {
  it("truncates summaryPreamble exceeding 8000 chars on read (corrupted file)", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    const overlong = "x".repeat(10_000);
    writeSessionMetadataFixture(sessionsDir, sessionId, { summaryPreamble: overlong });
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.summaryPreamble!.length).toBe(8_000);
  });

  it("does not alter preamble at exactly 8000 chars on read", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    const exact = "y".repeat(8_000);
    writeSessionMetadataFixture(sessionsDir, sessionId, { summaryPreamble: exact });
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.summaryPreamble!.length).toBe(8_000);
  });
});

describe("saveCheckpointSnapshot / loadCheckpointSnapshot", () => {
  const SESSION_SNAP = "dddddddd-0000-1111-2222-333333333333";

  it("round-trips messages through save and load", async () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    await mm.saveCheckpointSnapshot(SESSION_SNAP, 1, messages);
    const loaded = mm.loadCheckpointSnapshot(SESSION_SNAP, 1);
    expect(loaded).toEqual(messages);
  });

  it("returns null when snapshot does not exist", () => {
    const result = mm.loadCheckpointSnapshot(SESSION_SNAP, 99);
    expect(result).toBeNull();
  });

  it("snapshot files do NOT appear in listSessions", async () => {
    await mm.saveSession(SESSION_SNAP, [{ role: "user", content: "real session" }]);
    await mm.saveCheckpointSnapshot(SESSION_SNAP, 1, [{ role: "user", content: "pre-compact" }]);

    const sessions = mm.listSessions();
    const ids = sessions.map((s) => s.id);

    expect(ids).toContain(SESSION_SNAP);
    expect(ids.every((id) => !id.includes(".cp") && !id.includes(".checkpoints"))).toBe(true);
    const matchingReal = ids.filter((id) => id === SESSION_SNAP);
    expect(matchingReal).toHaveLength(1);
  });

  it("snapshot files do NOT appear in listSessionsPage", async () => {
    await mm.saveSession(SESSION_SNAP, [{ role: "user", content: "real" }]);
    await mm.saveCheckpointSnapshot(SESSION_SNAP, 2, [{ role: "user", content: "snap" }]);

    const page = mm.listSessionsPage({ limit: 100 });
    const ids = page.map((s) => s.id);
    expect(ids).toContain(SESSION_SNAP);
    expect(ids.every((id) => !id.includes(".cp") && !id.includes(".checkpoints"))).toBe(true);
  });

  it("multiple compactNums are all independently loadable", async () => {
    const m1 = [{ role: "user", content: "snap1" }];
    const m2 = [{ role: "user", content: "snap2" }, { role: "assistant", content: "a2" }];
    await mm.saveCheckpointSnapshot(SESSION_SNAP, 1, m1);
    await mm.saveCheckpointSnapshot(SESSION_SNAP, 2, m2);
    expect(mm.loadCheckpointSnapshot(SESSION_SNAP, 1)).toEqual(m1);
    expect(mm.loadCheckpointSnapshot(SESSION_SNAP, 2)).toEqual(m2);
  });

  it("rejects invalid sessionId without throwing fs errors", async () => {
    await expect(
      mm.saveCheckpointSnapshot("../evil/path", 1, []),
    ).rejects.toThrow(/invalid sessionId/);
    expect(mm.loadCheckpointSnapshot("../evil/path", 1)).toBeNull();
  });
});

describe("saveCheckpointSnapshot post-compaction simulation", () => {
  const SESSION_BRANCH = "eeeeeeee-0000-1111-2222-333333333333";

  it("snapshot survives a subsequent saveSession overwrite (simulates PostTurnHookChain)", async () => {
    const preCompact = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ];
    const postCompact = [{ role: "assistant", content: "compact summary only" }];

    await mm.saveCheckpointSnapshot(SESSION_BRANCH, 1, preCompact);

    await mm.saveSession(SESSION_BRANCH, postCompact);

    const loaded = mm.loadCheckpointSnapshot(SESSION_BRANCH, 1);
    expect(loaded).toEqual(preCompact);

    // loadSession adds missing row ids, so compare message content rather than saved literal bytes.
    const main = mm.loadSession(SESSION_BRANCH);
    expect(main).toMatchObject(postCompact);
  });
});

describe("saveSessionMetadata — invalid sessionId throws", () => {
  it("throws for path-traversal sessionId (../etc/passwd)", async () => {
    await expect(mm.saveSessionMetadata("../etc/passwd", {})).rejects.toThrow(
      /invalid sessionId/,
    );
  });

  it("throws for sessionId with a slash", async () => {
    await expect(mm.saveSessionMetadata("a/b", {})).rejects.toThrow(/invalid sessionId/);
  });

  it("throws for empty string sessionId", async () => {
    await expect(mm.saveSessionMetadata("", {})).rejects.toThrow(/invalid sessionId/);
  });
});

describe("saveSession / loadSession — invalid sessionId protection", () => {
  it("rejects path-traversal sessionId on save", async () => {
    await expect(mm.saveSession("../etc/passwd", [])).rejects.toThrow(/invalid sessionId/);
  });

  it("returns null for path-traversal sessionId on load", () => {
    expect(mm.loadSession("../etc/passwd")).toBeNull();
  });

  it("recovers the latest checkpoint user when a capped session lost every user row", async () => {
    const sessionId = SESSION_A;
    await mm.saveCheckpointSnapshot(sessionId, 1, [
      { role: "user", content: "older question" },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "폴더 전체를 삭제" },
    ]);
    await mm.saveSessionMetadata(sessionId, {
      checkpoints: [
        makeCheckpoint({
          compactNum: 1,
          messageCountAtTrigger: 3,
          summary: "summary",
        }),
      ],
    });
    await mm.saveSession(sessionId, [
      { role: "assistant", content: "정리해보니 delete_file 은 디렉터리에 쓸 수 없습니다." },
    ]);

    expect(mm.loadSession(sessionId)).toMatchObject([
      { role: "user", content: "폴더 전체를 삭제" },
      { role: "assistant", content: "정리해보니 delete_file 은 디렉터리에 쓸 수 없습니다." },
    ]);
  });
});

describe("loadSessionMetadata — invalid sessionId throws", () => {
  it("throws for path-traversal sessionId (../etc/passwd)", () => {
    expect(() => mm.loadSessionMetadata("../etc/passwd")).toThrow(/invalid sessionId/);
  });

  it("throws for sessionId with a slash", () => {
    expect(() => mm.loadSessionMetadata("a/b")).toThrow(/invalid sessionId/);
  });

  it("throws for empty string sessionId", () => {
    expect(() => mm.loadSessionMetadata("")).toThrow(/invalid sessionId/);
  });
});

describe("round-trip — write then read preserves all new fields", () => {
  it("persists all new fields and reads them back identically", async () => {
    const sessionId = SESSION_C;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);

    const ckpt = makeCheckpoint({
      id: "ckpt-rt-01",
      trigger: "manual",
      ctxUsageAtTrigger: 0.42,
      summary: null,
      messageCountAtTrigger: 10,
    });
    const meta: SessionMetadata = {
      sessionKind: "routine",
      routineId: "r2",
      parentSessionId: SESSION_A,
      summaryPreamble: "prior context summary",
      checkpoints: [ckpt],
    };

    await mm.saveSessionMetadata(sessionId, meta);
    const loaded = mm.loadSessionMetadata(sessionId);

    expect(loaded).not.toBeNull();
    expect(loaded!.routineId).toBe("r2");
    expect(loaded!.parentSessionId).toBe(SESSION_A);
    expect(loaded!.summaryPreamble).toBe("prior context summary");
    expect(loaded!.checkpoints).toHaveLength(1);
    expect(loaded!.checkpoints![0]).toEqual(ckpt);
  });
});

describe("pruneCheckpointsDiscardedByRewind", () => {
  const boundary = (compactNum: number) => ({
    role: "user",
    content: "[compacted]",
    meta: { compactBoundary: true, compactNum, messageId: `boundary-${compactNum}` },
  });
  const question = (text: string) => ({
    role: "user",
    content: text,
    meta: { messageId: `q-${text}` },
  });

  it("keeps every checkpoint when the rewind discarded no boundary", async () => {
    // Earlier compact boundaries may already be summarized away; their absence alone must not delete snapshots.
    await mm.saveSessionMetadata(SESSION_A, {
      checkpoints: [makeCheckpoint({ compactNum: 1 }), makeCheckpoint({ id: "ckpt-0002", compactNum: 2 })],
    });
    await mm.saveCheckpointSnapshot(SESSION_A, 1, [question("first cycle")]);
    await mm.saveCheckpointSnapshot(SESSION_A, 2, [question("second cycle")]);

    await mm.pruneCheckpointsDiscardedByRewind(SESSION_A, [question("the last message")]);

    expect(mm.loadSessionMetadata(SESSION_A)?.checkpoints?.map((c) => c.compactNum)).toEqual([1, 2]);
    expect(mm.loadCheckpointSnapshot(SESSION_A, 1)).not.toBeNull();
    expect(mm.loadCheckpointSnapshot(SESSION_A, 2)).not.toBeNull();
  });

  it("drops only the checkpoint whose boundary this rewind discarded", async () => {
    await mm.saveSessionMetadata(SESSION_A, {
      checkpoints: [makeCheckpoint({ compactNum: 1 }), makeCheckpoint({ id: "ckpt-0002", compactNum: 2 })],
    });
    await mm.saveCheckpointSnapshot(SESSION_A, 1, [question("first cycle")]);
    await mm.saveCheckpointSnapshot(SESSION_A, 2, [question("second cycle")]);

    await mm.pruneCheckpointsDiscardedByRewind(SESSION_A, [boundary(2), question("after the boundary")]);

    expect(mm.loadSessionMetadata(SESSION_A)?.checkpoints?.map((c) => c.compactNum)).toEqual([1]);
    expect(mm.loadCheckpointSnapshot(SESSION_A, 1)).not.toBeNull();
    expect(mm.loadCheckpointSnapshot(SESSION_A, 2)).toBeNull();
  });

  it("keeps a checkpoint that never recorded a compact number", async () => {
    await mm.saveSessionMetadata(SESSION_B, {
      checkpoints: [makeCheckpoint({ id: "ckpt-manual" }), makeCheckpoint({ id: "ckpt-0003", compactNum: 3 })],
    });

    await mm.pruneCheckpointsDiscardedByRewind(SESSION_B, [boundary(3)]);

    expect(mm.loadSessionMetadata(SESSION_B)?.checkpoints?.map((c) => c.id)).toEqual(["ckpt-manual"]);
  });

  it("deletes the pre-compact snapshot a dropped checkpoint owned", async () => {
    await mm.saveSessionMetadata(SESSION_B, { checkpoints: [makeCheckpoint({ compactNum: 3 })] });
    await mm.saveCheckpointSnapshot(SESSION_B, 3, [question("archived")]);
    expect(mm.loadCheckpointSnapshot(SESSION_B, 3)).not.toBeNull();

    await mm.pruneCheckpointsDiscardedByRewind(SESSION_B, [boundary(3)]);

    expect(mm.loadCheckpointSnapshot(SESSION_B, 3)).toBeNull();
  });

  it("drops the summary preamble only when the newest checkpoint goes with it", async () => {
    // Only losing the latest checkpoint invalidates the summary preamble.
    await mm.saveSessionMetadata(SESSION_A, {
      summaryPreamble: "prior context summary",
      checkpoints: [makeCheckpoint({ compactNum: 1 }), makeCheckpoint({ id: "ckpt-0002", compactNum: 2 })],
    });

    await mm.pruneCheckpointsDiscardedByRewind(SESSION_A, [boundary(1)]);
    expect(mm.loadSessionMetadata(SESSION_A)?.summaryPreamble).toBe("prior context summary");

    await mm.pruneCheckpointsDiscardedByRewind(SESSION_A, [boundary(2)]);
    expect(mm.loadSessionMetadata(SESSION_A)?.summaryPreamble).toBeUndefined();
  });

  it("a session rewound to its opening message reloads empty, not carrying the discarded message back", async () => {
    // Prune checkpoint recovery state before rewind or reload can resurrect a discarded user message.
    await mm.saveSessionMetadata(SESSION_C, { checkpoints: [makeCheckpoint({ compactNum: 1 })] });
    await mm.saveCheckpointSnapshot(SESSION_C, 1, [question("the discarded question")]);
    await mm.saveSession(SESSION_C, [boundary(1)] as never);
    expect(JSON.stringify(mm.loadSession(SESSION_C))).toContain("the discarded question");

    await mm.pruneCheckpointsDiscardedByRewind(SESSION_C, [boundary(1), question("the discarded question")]);
    await mm.saveSession(SESSION_C, [] as never);

    expect(mm.loadSession(SESSION_C)).toEqual([]);
  });
});

describe("isValidSessionId — one rule for every session id", () => {
  const UUID = "12434f55-fbb9-4a54-b1a7-fb9638d8eebd";

  it("accepts a bare lowercase UUID and the two minted namespaces", () => {
    expect(isValidSessionId(UUID)).toBe(true);
    expect(isValidSessionId(`sub-x-${UUID}`)).toBe(true);
    expect(isValidSessionId(`sub-e3b0c442-${UUID}`)).toBe(true);
    expect(isValidSessionId(`a2a-wire-1a2b3c4d-${UUID}`)).toBe(true);
  });

  it("rejects what the four earlier validators disagreed on", () => {
    expect(isValidSessionId("a".repeat(257))).toBe(false);
    expect(isValidSessionId("parent-session")).toBe(false);
    expect(isValidSessionId(UUID.toUpperCase())).toBe(false);
    expect(isValidSessionId(`side-x-${UUID}`)).toBe(false);
    expect(isValidSessionId(`sub-${UUID}`)).toBe(false);
    expect(isValidSessionId(`sub-X_y-${UUID}`)).toBe(false);
    expect(isValidSessionId("../etc/passwd")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
  });
});
