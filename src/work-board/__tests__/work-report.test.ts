/** Short-circuit empty report windows without model calls; persist real output and propagate generation failures. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWorkBoardReporter } from "../work-report.js";
import { MEMORY_FILE } from "../work-memory.js";
import { okListReader, projectMemoryPath, projectReportPath } from "./board-test-fixtures.js";
import type { WorkBoardStorage } from "../storage.js";
import type {
  WorkItem,
  WorkItemResolved,
} from "../../shared/work-board-types.js";

const NOW = Date.parse("2026-06-16T03:00:00.000Z");
// Pin the fixture zone so stored instants retain their intended civil-day meaning.
let previousTz: string | undefined;
beforeEach(() => {
  previousTz = process.env.TZ;
  process.env.TZ = "Asia/Seoul";
});
afterEach(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});


function item(
  p: Partial<WorkItem> & { id: number; status_resolved?: WorkItemResolved["status_resolved"] },
): WorkItemResolved {
  const { status_resolved, ...rest } = p;
  const base: WorkItem = {
    title: `item ${p.id}`,
    status: "planned",
    priority: "medium",
    created_at: "2026-06-16T01:00:00.000Z", // 10:00 local 16th — inside today + this week
    updated_at: "2026-06-16T01:00:00.000Z",
    ...rest,
  };
  return { ...base, status_resolved: status_resolved ?? base.status };
}

function memStorage(): WorkBoardStorage & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    readJson: async <T>(rel: string) => (rel in files ? (JSON.parse(files[rel]) as T) : null),
    writeJson: async (rel, value) => {
      files[rel] = JSON.stringify(value);
    },
    readText: async (rel) => files[rel] ?? "",
    write: async (rel, data) => {
      files[rel] = data;
    },
    exists: async (rel) => rel in files,
    mkdir: async () => {},
  };
}

function llmRecorder(reply = "# 리포트\n내용") {
  const calls: Array<{ prompt: string; system?: string }> = [];
  return {
    calls,
    callLlm: async (prompt: string, opts?: { systemPrompt?: string }) => {
      calls.push({ prompt, system: opts?.systemPrompt });
      return reply;
    },
  };
}

describe("work-report — daily", () => {
  it("empty board → empty envelope, no LLM call", async () => {
    const { callLlm, calls } = llmRecorder();
    const reporter = createWorkBoardReporter({ store: okListReader([]), storage: memStorage(), callLlm, now: () => NOW });
    const r = await reporter.generateDaily();
    expect(r.status).toBe("empty");
    expect(calls).toHaveLength(0);
  });

  it("invalid date → empty envelope, no LLM call", async () => {
    const { callLlm, calls } = llmRecorder();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage: memStorage(), callLlm, now: () => NOW });
    const r = await reporter.generateDaily({ date: "2026-6-16" });
    expect(r).toMatchObject({ status: "empty", period: "2026-6-16" });
    expect(calls).toHaveLength(0);
  });

  it("populated board → ok, writes markdown, appends memory, one LLM call", async () => {
    const { callLlm, calls } = llmRecorder();
    const storage = memStorage();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage, callLlm, now: () => NOW });

    const r = await reporter.generateDaily();
    expect(r).toMatchObject({ status: "ok", kind: "daily", period: "2026-06-16", markdown: "# 리포트\n내용" });
    expect(calls).toHaveLength(1);
    expect(storage.files["reports/daily/2026-06-16.md"]).toBe("# 리포트\n내용");
    expect(storage.files[MEMORY_FILE]).toContain("2026-06-16:");
  });

  it("uses project-scoped work memory for project reports", async () => {
    const { callLlm, calls } = llmRecorder();
    const storage = memStorage();
    storage.files[MEMORY_FILE] = "# 업무 흐름 메모리\n\nglobal-report-leak\n";
    const reporter = createWorkBoardReporter({
      store: okListReader([item({ id: 1, projectRoot: "C:\\workspace\\alpha", projectName: "alpha" })]),
      storage,
      callLlm,
      now: () => NOW,
    });

    const r = await reporter.generateDaily({ projectRoot: "C:\\workspace\\alpha" });
    const projectPath = projectMemoryPath(storage.files);
    const reportPath = projectReportPath(storage.files, "daily");

    expect(r.status).toBe("ok");
    expect(calls[0]?.prompt).not.toContain("global-report-leak");
    expect(storage.files["reports/daily/2026-06-16.md"]).toBeUndefined();
    expect(reportPath).toBeDefined();
    expect(storage.files[reportPath!]).toBe("# 리포트\n내용");
    expect(storage.files[MEMORY_FILE]).not.toContain("2026-06-16:");
    expect(projectPath).toBeDefined();
    expect(storage.files[projectPath!]).toContain("2026-06-16:");
  });

  it("propagates an LLM failure (No-Fallback — no stub report)", async () => {
    const failing = async () => {
      throw new Error("provider down");
    };
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage: memStorage(), callLlm: failing, now: () => NOW });
    await expect(reporter.generateDaily()).rejects.toThrow("provider down");
  });
});

describe("work-report — weekly", () => {
  it("no activity this week → empty envelope, no LLM call", async () => {
    const { callLlm, calls } = llmRecorder();
    const old = item({ id: 1, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
    const reporter = createWorkBoardReporter({ store: okListReader([old]), storage: memStorage(), callLlm, now: () => NOW });
    const r = await reporter.generateWeekly();
    expect(r.status).toBe("empty");
    expect(calls).toHaveLength(0);
  });

  it("rejects a traversal-bearing weekIso BEFORE any file write (security)", async () => {
    const { callLlm, calls } = llmRecorder();
    const storage = memStorage();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage, callLlm, now: () => NOW });

    const r = await reporter.generateWeekly({ weekIso: "../../etc/evil" });
    expect(r.status).toBe("empty"); // refused — not generated
    expect(calls).toHaveLength(0); // no LLM call
    // No file escaped the namespace (no write happened at all).
    expect(Object.keys(storage.files)).toHaveLength(0);
  });

  it("activity this week → ok, writes weekly markdown", async () => {
    const { callLlm, calls } = llmRecorder();
    const storage = memStorage();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage, callLlm, now: () => NOW });
    const r = await reporter.generateWeekly();
    expect(r.status).toBe("ok");
    expect(calls).toHaveLength(1);
    if (r.status === "ok") {
      expect(storage.files[`reports/weekly/${r.period}.md`]).toBe("# 리포트\n내용");
    }
  });

  it("writes project weekly reports under a project namespace", async () => {
    const { callLlm } = llmRecorder();
    const storage = memStorage();
    const reporter = createWorkBoardReporter({
      store: okListReader([item({ id: 1, projectRoot: "C:\\workspace\\alpha", projectName: "alpha" })]),
      storage,
      callLlm,
      now: () => NOW,
    });

    const r = await reporter.generateWeekly({ projectRoot: "C:\\workspace\\alpha" });
    const reportPath = projectReportPath(storage.files, "weekly");

    expect(r.status).toBe("ok");
    expect(reportPath).toBeDefined();
    if (r.status === "ok") {
      expect(storage.files[`reports/weekly/${r.period}.md`]).toBeUndefined();
      expect(storage.files[reportPath!]).toBe("# 리포트\n내용");
    }
  });
});

describe("work-report — dispatch", () => {
  it("generate('weekly') routes to the weekly handler", async () => {
    const { callLlm } = llmRecorder();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage: memStorage(), callLlm, now: () => NOW });
    const r = await reporter.generate("weekly");
    expect(r.kind).toBe("weekly");
  });

  it("generate('daily') routes to the daily handler", async () => {
    const { callLlm } = llmRecorder();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage: memStorage(), callLlm, now: () => NOW });
    const r = await reporter.generate("daily");
    expect(r.kind).toBe("daily");
  });
});

describe("work-report — day labels follow the host calendar", () => {
  /** Project stored due instants through host-local calendars on both sides of UTC; UTC prefixes can name the wrong day. */
  function runInZone(zone: string, dueAt: string): Promise<string> {
    process.env.TZ = zone;
    const { callLlm, calls } = llmRecorder();
    const reporter = createWorkBoardReporter({
      store: okListReader([item({ id: 1, due_at: dueAt })]),
      storage: memStorage(),
      callLlm,
      now: () => NOW,
    });
    return reporter.generateDaily().then(() => calls[0]?.prompt ?? "");
  }

  it("prints the picked day in the (due …) label, east and west of UTC", async () => {
    expect(await runInZone("Asia/Seoul", "2026-06-15T15:00:00.000Z"))
      .toContain("(due 2026-06-16)");

    expect(await runInZone("America/Los_Angeles", "2026-06-16T07:00:00.000Z"))
      .toContain("(due 2026-06-16)");
  });

  it("prints the weekly header from the local week bounds, not their UTC prefix", async () => {
    process.env.TZ = "Asia/Seoul";
    const { callLlm, calls } = llmRecorder();
    const reporter = createWorkBoardReporter({
      store: okListReader([item({ id: 1 })]),
      storage: memStorage(),
      callLlm,
      now: () => NOW,
    });
    await reporter.generateWeekly();

    expect(calls[0]?.prompt).toContain("(2026-06-14 ~ 2026-06-20)");
  });
});
