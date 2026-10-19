/**
 * Storage half of mid-turn durability: append-as-you-go rows, the in-flight
 * sidecar, torn-line tolerance, and the recovery a load performs when the
 * process that ran the last turn died.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { appendJsonlRecords, turnInflightPath, writeTurnInflightRecord } from "../session-turn-journal.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SESSION = "c0ffee00-1111-2222-3333-444444444444";

let dir: string;
let mm: MemoryManager;

const transcriptPath = () => join(dir, "sessions", `${SESSION}.jsonl`);
const sidecarPath = () => turnInflightPath(join(dir, "sessions"), SESSION);
const lines = () => readFileSync(transcriptPath(), "utf-8").split("\n").filter((l) => l.length > 0);

function row(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...extra, meta: { messageId: id, ...(extra.meta as object | undefined) } };
}

const user = row("u1", { role: "user", content: "작업해 줘" });
const round1 = row("a1", {
  role: "assistant",
  content: "먼저 파일을 읽습니다",
  toolCalls: [{ id: "call-1", name: "read_file", input: { path: "a.txt" } }],
});
const result1 = row("r1", { role: "tool_result", toolUseId: "call-1", toolName: "read_file", content: "hello" });
const round2 = row("a2", {
  role: "assistant",
  content: "두 번째 도구",
  toolCalls: [{ id: "call-2", name: "bash", input: { command: "sleep 100" } }],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-turn-journal-"));
  mm = new MemoryManager({ aveDir: dir });
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("appendSessionProgress", () => {
  it("appends only the new rows after a save, and reports unchanged when nothing is new", async () => {
    await mm.saveSession(SESSION, [user]);
    expect(await mm.appendSessionProgress(SESSION, [user, round1])).toBe("appended");
    expect(await mm.appendSessionProgress(SESSION, [user, round1, result1])).toBe("appended");
    expect(await mm.appendSessionProgress(SESSION, [user, round1, result1])).toBe("unchanged");
    expect(lines()).toHaveLength(3);
    expect(mm.loadSession(SESSION)).toEqual([user, round1, result1]);
  });

  it("rewrites instead of appending when history no longer extends what is on disk", async () => {
    await mm.saveSession(SESSION, [user, round1]);
    // Compaction / a rolled-back injection replaced the prefix.
    const compacted = row("u1b", { role: "user", content: "요약된 질문" });
    expect(await mm.appendSessionProgress(SESSION, [compacted, result1])).toBe("rewritten");
    expect(mm.loadSession(SESSION)).toEqual([compacted, result1]);
  });

  it("rewrites when another writer touched the file since this process wrote it", async () => {
    await mm.saveSession(SESSION, [user]);
    appendFileSync(transcriptPath(), `${JSON.stringify(row("x1", { role: "assistant", content: "외부" }))}\n`);
    expect(await mm.appendSessionProgress(SESSION, [user, round1])).toBe("rewritten");
    expect(mm.loadSession(SESSION)).toEqual([user, round1]);
  });

  it("leaves no duplicate rows when the turn's final save rewrites the appended file", async () => {
    await mm.saveSession(SESSION, [user]);
    await mm.appendSessionProgress(SESSION, [user, round1]);
    await mm.appendSessionProgress(SESSION, [user, round1, result1]);
    const final = row("a3", { role: "assistant", content: "끝", meta: { turnSummary: { toolCount: 1 } } });
    await mm.saveSession(SESSION, [user, round1, result1, final]);
    const ids = (mm.loadSession(SESSION) as Array<{ meta: { messageId: string } }>).map((m) => m.meta.messageId);
    expect(ids).toEqual(["u1", "a1", "r1", "a3"]);
    expect(lines()).toHaveLength(4);
  });

  it("stores an appended oversized tool_result the way a save does (stub + artifact)", async () => {
    await mm.saveSession(SESSION, [user, round1]);
    const huge = row("r-big", { role: "tool_result", toolUseId: "call-1", toolName: "read_file", content: "x".repeat(2_000_000), meta: { truncated: { originalLines: 1, originalTokens: 500_000, originalBytes: 2_000_000, trimmedAt: "2026-10-20T00:00:00.000Z" } } });
    await mm.appendSessionProgress(SESSION, [user, round1, huge]);
    const appendedLine = lines()[2];
    expect(appendedLine.length).toBeLessThan(200_000);
    expect(JSON.parse(appendedLine).meta.serializedStub).toBe(true);
  });
});

describe("torn final line", () => {
  it("skips a half-written last line on load and terminates it before the next append", async () => {
    await mm.saveSession(SESSION, [user, round1]);
    // A process killed mid-write leaves an unterminated fragment.
    appendFileSync(transcriptPath(), '{"role":"tool_result","toolUseId":"call-1","con');
    expect(mm.loadSession(SESSION)).toEqual([user, round1]);

    // A fresh process (no write state) appends after a rewrite; one already
    // holding state rewrites because the file changed under it. Either way the
    // next record must not fuse with the fragment.
    const fresh = new MemoryManager({ aveDir: dir });
    await fresh.saveSession(SESSION, mm.loadSession(SESSION) ?? []);
    expect(await fresh.appendSessionProgress(SESSION, [user, round1, result1])).toBe("appended");
    expect(fresh.loadSession(SESSION)).toEqual([user, round1, result1]);
  });

  it("newline-terminates a torn tail before appending, so the next record never fuses with it", async () => {
    const path = join(dir, "raw.jsonl");
    writeFileSync(path, `${JSON.stringify(user)}\n{"role":"assi`);
    await appendJsonlRecords(path, [round1]);
    const raw = readFileSync(path, "utf-8").split("\n").filter((l) => l.length > 0);
    expect(raw).toHaveLength(3);
    expect(JSON.parse(raw[2])).toEqual(round1);
  });
});

describe("in-flight sidecar recovery", () => {
  /**
   * The files a process leaves when it dies mid-turn: the rows it appended and
   * the in-flight sidecar, with nobody in THIS process holding the journal
   * open (that registry is process-local, so a test writes the sidecar the way
   * the dead process did rather than opening a journal it would then own).
   */
  async function crashMidTurn(rows: unknown[], partial?: { messageId: string; content: string }): Promise<void> {
    await mm.saveSession(SESSION, [user]);
    await mm.appendSessionProgress(SESSION, rows);
    await writeTurnInflightRecord(sidecarPath(), {
      v: 1,
      startedAt: 1_000,
      ...(partial ? { partial: { ...partial, updatedAt: 2_000 } } : {}),
    });
  }

  it("folds the streaming partial into an interrupted host-exit assistant row", async () => {
    await crashMidTurn([user, round1, result1], { messageId: "a2-partial", content: "두 번째 라운드 답변의 앞부분" });
    const reloaded = new MemoryManager({ aveDir: dir }).loadSession(SESSION) as Array<Record<string, any>>;
    expect(reloaded.slice(0, 3)).toEqual([user, round1, result1]);
    expect(reloaded[3]).toMatchObject({
      role: "assistant",
      content: "두 번째 라운드 답변의 앞부분",
      meta: { messageId: "a2-partial", interrupted: true, interruptedBy: "host-exit" },
    });
    expect(reloaded).toHaveLength(4);
  });

  it("never shows a partial beside the committed row that superseded it", async () => {
    const committed = row("a2-partial", { role: "assistant", content: "완성된 두 번째 라운드" });
    await crashMidTurn([user, round1, result1, committed], { messageId: "a2-partial", content: "완성된" });
    const reloaded = new MemoryManager({ aveDir: dir }).loadSession(SESSION) as Array<Record<string, any>>;
    // Plain answer last → the turn had finished; nothing synthesized.
    expect(reloaded).toEqual([user, round1, result1, committed]);
  });

  it("gives an unanswered tool call an 'interrupted, result unknown' result instead of dropping it", async () => {
    await crashMidTurn([user, round1, result1, round2]);
    const reloaded = new MemoryManager({ aveDir: dir }).loadSession(SESSION) as Array<Record<string, any>>;
    const synthetic = reloaded.find((m) => m.role === "tool_result" && m.toolUseId === "call-2");
    expect(synthetic).toMatchObject({
      isError: true,
      toolName: "bash",
      meta: { toolDisplay: { cancelled: true } },
    });
    expect(String(synthetic?.content)).toMatch(/unknown|알 수 없/);
    // …and the tail says where the turn stopped.
    expect(reloaded[reloaded.length - 1]).toMatchObject({
      role: "assistant",
      content: "",
      meta: { interrupted: true, interruptedBy: "host-exit" },
    });
    // Deterministic: a second reader names the synthesized rows identically.
    const again = new MemoryManager({ aveDir: dir }).loadSession(SESSION) as Array<Record<string, any>>;
    expect(again.map((m) => m.meta.messageId)).toEqual(reloaded.map((m) => m.meta.messageId));
  });

  it("leaves a bare question alone when the turn died before producing anything", async () => {
    await crashMidTurn([user]);
    expect(new MemoryManager({ aveDir: dir }).loadSession(SESSION)).toEqual([user]);
  });

  it("does not fold the sidecar of a turn that is still running in this process", async () => {
    await mm.saveSession(SESSION, [user]);
    await mm.beginTurnJournal(SESSION, 1_000);
    await mm.writeTurnPartial(SESSION, 1_000, { messageId: "live", content: "아직 스트리밍 중", updatedAt: 1_500 });
    expect(mm.loadSession(SESSION)).toEqual([user]);
    mm.endTurnJournal(SESSION);
    expect(existsSync(sidecarPath())).toBe(false);
  });

  it("drops the orphaned sidecar once a whole-history save has absorbed the recovered rows", async () => {
    await crashMidTurn([user, round1, result1], { messageId: "p", content: "부분" });
    const next = new MemoryManager({ aveDir: dir });
    const recovered = next.loadSession(SESSION) ?? [];
    await next.saveSession(SESSION, recovered);
    expect(existsSync(sidecarPath())).toBe(false);
    expect(next.loadSession(SESSION)).toEqual(recovered);
  });

  it("ignores a sidecar that is not one this host wrote", async () => {
    await mm.saveSession(SESSION, [user, round1]);
    await writeTurnInflightRecord(sidecarPath(), { v: 1, startedAt: 1 });
    writeFileSync(sidecarPath(), JSON.stringify({ v: 1, startedAt: "yesterday" }));
    expect(new MemoryManager({ aveDir: dir }).loadSession(SESSION)).toEqual([user, round1]);
  });
});

describe("Continue after an interrupted turn", () => {
  it("keeps the session's title and preview on what the user asked, not the host's resume instruction", async () => {
    const answer = row("a3", { role: "assistant", content: "부분 답변", meta: { interrupted: true, interruptedBy: "host-exit" } });
    const resume = row("u2", {
      role: "user",
      content: "Continue from where you left off. Your previous response was interrupted because the app closed.",
      meta: { displayText: "Continue", resumesInterruptedTurn: true },
    });
    const resumed = row("a4", { role: "assistant", content: "이어서 마무리했습니다" });
    await mm.saveSession(SESSION, [user, answer, resume, resumed]);
    const entry = mm.listSessions().find((s) => s.id === SESSION);
    expect(entry?.title).toBe("작업해 줘");
    expect(entry?.preview).toBe("이어서 마무리했습니다");
  });
});
