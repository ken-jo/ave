import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsPromises from "node:fs/promises";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { appendJsonlRecords, turnInflightPath, writeTurnInflightRecord } from "../session-turn-journal.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SESSION = "c0ffee00-1111-2222-3333-444444444444";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

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

  it("appends reverse completions and loads every batch in call order without a sidecar", async () => {
    const calls = ["first", "second", "third"];
    const assistant = row("parallel", { role: "assistant", content: "", toolCalls: calls.map((id) => ({ id, name: "read_file", input: {} })) });
    const results = calls.map((id) => row("result-" + id, { role: "tool_result", toolUseId: id, content: id }));
    const history = [user, assistant];
    await mm.saveSession(SESSION, history);
    for (let i = calls.length - 1; i >= 0; i--) {
      history.splice(2, 0, results[i]);
      expect(await mm.appendSessionProgress(SESSION, history)).toBe("appended");
      expect(new MemoryManager({ aveDir: dir }).loadSession(SESSION)).toEqual(history);
    }
    expect(lines().slice(2).map((line) => JSON.parse(line).toolUseId)).toEqual([...calls].reverse());
    // A later round must not rewrite the earlier completion-order group.
    history.push(round2, row("next-result", { role: "tool_result", toolUseId: "call-2", content: "next round" }));
    expect(await mm.appendSessionProgress(SESSION, history)).toBe("appended");
    expect(new MemoryManager({ aveDir: dir }).loadSession(SESSION)).toEqual(history);
    expect(existsSync(sidecarPath())).toBe(false);
    // The final save is the normalization point, and later progress remains append-only.
    await mm.saveSession(SESSION, history);
    expect(lines().map((line) => JSON.parse(line))).toEqual(history);
    expect(await mm.appendSessionProgress(SESSION, history)).toBe("unchanged");
  });

  it("rewrites an open tool tail when an existing result was removed", async () => {
    const assistant = row("parallel", { role: "assistant", content: "", toolCalls: [
      { id: "call-1", name: "read_file", input: {} },
      { id: "call-2", name: "read_file", input: {} },
    ] });
    const result2 = row("r2", { role: "tool_result", toolUseId: "call-2", content: "second" });
    await mm.saveSession(SESSION, [user, assistant, result1, result2]);
    expect(await mm.appendSessionProgress(SESSION, [user, assistant, result2])).toBe("rewritten");
    expect(mm.loadSession(SESSION)).toEqual([user, assistant, result2]);
  });

  it("reads rows and ids together after a supplied history grows during async stat", async () => {
    await mm.saveSession(SESSION, [user]);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(fsPromises.stat).mockImplementationOnce((async (...args) => {
      entered();
      await blocked;
      return Reflect.apply(actual.stat, undefined, args);
    }) as typeof fsPromises.stat);
    const history = [user, round1];
    const progress = mm.appendSessionProgress(SESSION, history);
    await entering;
    history.push(result1);
    release();
    expect(await progress).toBe("appended");
    expect(await mm.appendSessionProgress(SESSION, history)).toBe("unchanged");
    expect(lines().map((line) => JSON.parse(line))).toEqual(history);
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
    appendFileSync(transcriptPath(), '{"role":"tool_result","toolUseId":"call-1","con');
    expect(mm.loadSession(SESSION)).toEqual([user, round1]);

    // Repair the torn final line before either a fresh append or a stale-writer rewrite.
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
  // Write an orphan sidecar directly; opening a local journal would register a live owner and suppress recovery.
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
    expect(reloaded[reloaded.length - 1]).toMatchObject({
      role: "assistant",
      content: "",
      meta: { interrupted: true, interruptedBy: "host-exit" },
    });
    const again = new MemoryManager({ aveDir: dir }).loadSession(SESSION) as Array<Record<string, any>>;
    expect(again.map((m) => m.meta.messageId)).toEqual(reloaded.map((m) => m.meta.messageId));
  });

  it("orders completed and unknown results by call id when a later parallel call finished first", async () => {
    const assistant = row("batch", {
      role: "assistant",
      content: "two tools",
      toolCalls: [
        { id: "slow", name: "read_file", input: {} },
        { id: "done", name: "read_file", input: {} },
      ],
    });
    const completed = row("done-result", { role: "tool_result", toolUseId: "done", content: "finished output" });
    await crashMidTurn([user, assistant, completed]);
    const restored = new MemoryManager({ aveDir: dir }).loadSession(SESSION) as Array<Record<string, any>>;
    expect(restored.slice(2, 4)).toEqual([
      expect.objectContaining({ toolUseId: "slow", isError: true, meta: expect.objectContaining({ toolDisplay: { cancelled: true } }) }),
      completed,
    ]);
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
    expect(existsSync(sidecarPath())).toBe(true);
    expect(new MemoryManager({ aveDir: dir }).loadSession(SESSION)).toEqual([
      user,
      expect.objectContaining({ role: "assistant", content: "아직 스트리밍 중" }),
    ]);
    mm.clearTurnJournal(SESSION);
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
