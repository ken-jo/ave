import { beforeAll, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { configureHostResources } from "../../../main/host-resources.js";

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
import type { IpcDeps } from "../../types.js";
import {
  defaultWorkspaceProjectPayload,
  handleChatSessions,
  markMainActiveAfterTurn,
  parseChatSessionProjectPayload,
  resolveChatNewProjectPayload,
} from "../chat.js";

describe("chat project payloads", () => {
  it("keeps project identity as projectRoot/projectName only", () => {
    expect(parseChatSessionProjectPayload({
      projectScope: "none",
      projectRoot: "  C:\\workspace\\alpha  ",
      projectName: "  alpha  ",
    })).toEqual({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(parseChatSessionProjectPayload({ projectScope: "none" })).toEqual({});
  });

  it("defaults unscoped new chats to the default project", () => {
    expect(resolveChatNewProjectPayload(undefined, "C:\\Users\\example\\workspace")).toEqual({
      projectRoot: "C:\\Users\\example\\workspace",
      projectName: "default",
    });
    expect(resolveChatNewProjectPayload({ projectRoot: "  " }, "C:\\Users\\example\\workspace")).toEqual({
      projectRoot: "C:\\Users\\example\\workspace",
      projectName: "default",
    });
    expect(resolveChatNewProjectPayload({ projectName: "loose-name" }, "C:\\Users\\example\\workspace")).toEqual({
      projectRoot: "C:\\Users\\example\\workspace",
      projectName: "default",
    });
  });

  it("does not override an explicit project selection", () => {
    expect(resolveChatNewProjectPayload({
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
    }, "C:\\Users\\example\\workspace")).toEqual({
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
    });
  });

  it("labels the default project with the stable 'default' literal", () => {
    expect(defaultWorkspaceProjectPayload("")).toEqual({
      projectName: "default",
    });
  });
});

describe("markMainActiveAfterTurn across chat tiles", () => {
  it("moves the resume target for the primary tile only", async () => {
    const markMainActiveResume = vi.fn(async () => {});
    const base = {
      conversationLoop: {
        getSessionKind: () => "main",
        getHistory: () => [{ role: "user", content: "hello" }],
        getSessionId: () => "session-tile",
        getSessionProjectIsDefault: () => true,
        getSessionProjectContext: () => null,
      },
      memoryManager: {
        sessions: {
          loadSessionMetadata: vi.fn(() => ({})),
          saveSessionMetadata: vi.fn(async () => {}),
          markMainActiveResume,
          markMainActiveFresh: vi.fn(async () => {}),
        },
      },
    };
    await markMainActiveAfterTurn({ ...base, chatGroupId: "group-2" } as unknown as IpcDeps, "hello", "user-keyboard");
    expect(markMainActiveResume).not.toHaveBeenCalled();
    await markMainActiveAfterTurn({ ...base, chatGroupId: "main" } as unknown as IpcDeps, "hello", "user-keyboard");
    await markMainActiveAfterTurn(base as unknown as IpcDeps, "hello", "user-keyboard");
    expect(markMainActiveResume).toHaveBeenCalledTimes(2);
  });
});

describe("markMainActiveAfterTurn project metadata", () => {
  it("persists the current main session project identity without a no-project scope", async () => {
    const saveSessionMetadata = vi.fn(async () => {});
    const markMainActiveResume = vi.fn(async () => {});
    const deps = {
      conversationLoop: {
        getSessionKind: () => "main",
        getHistory: () => [{ role: "user", content: "hello" }],
        getSessionId: () => "session-1",
        getSessionProjectIsDefault: () => false,
        getSessionProjectContext: () => ({
          projectRoot: "C:\\workspace\\alpha",
          projectName: "alpha",
        }),
      },
      memoryManager: {
        sessions: {
          loadSessionMetadata: vi.fn(() => ({ title: "Existing title" })),
          saveSessionMetadata,
          markMainActiveResume,
          markMainActiveFresh: vi.fn(async () => {}),
        },
      },
    } as unknown as IpcDeps;

    await markMainActiveAfterTurn(deps, "hello", "user-keyboard");

    expect(saveSessionMetadata).toHaveBeenCalledWith("session-1", {
      title: "Existing title",
      sessionKind: "main",
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(saveSessionMetadata.mock.calls[0]?.[1]).not.toHaveProperty("projectScope");
    expect(markMainActiveResume).toHaveBeenCalledWith("session-1");
  });

  it("does NOT persist project metadata when the session's project is the default binding (no explicit selection)", async () => {
    // Default-directory access must not persist explicit project metadata after a turn.
    const saveSessionMetadata = vi.fn(async () => {});
    const markMainActiveResume = vi.fn(async () => {});
    const deps = {
      conversationLoop: {
        getSessionKind: () => "main",
        getHistory: () => [{ role: "user", content: "hello" }],
        getSessionId: () => "session-1",
        getSessionProjectIsDefault: () => true,
        getSessionProjectContext: () => ({
          projectRoot: "C:\\Users\\example\\.ave\\workspace",
          projectName: "default",
        }),
      },
      memoryManager: {
        sessions: {
          loadSessionMetadata: vi.fn(() => null),
          saveSessionMetadata,
          markMainActiveResume,
          markMainActiveFresh: vi.fn(async () => {}),
        },
      },
    } as unknown as IpcDeps;

    await markMainActiveAfterTurn(deps, "hello", "user-keyboard");

    expect(saveSessionMetadata).not.toHaveBeenCalled();
    expect(markMainActiveResume).toHaveBeenCalledWith("session-1");
  });

  it("still persists project metadata for an explicit (non-default) project after a turn", async () => {
    const saveSessionMetadata = vi.fn(async () => {});
    const markMainActiveResume = vi.fn(async () => {});
    const deps = {
      conversationLoop: {
        getSessionKind: () => "main",
        getHistory: () => [{ role: "user", content: "hello" }],
        getSessionId: () => "session-1",
        getSessionProjectIsDefault: () => false,
        getSessionProjectContext: () => ({
          projectRoot: "C:\\workspace\\alpha",
          projectName: "alpha",
        }),
      },
      memoryManager: {
        sessions: {
          loadSessionMetadata: vi.fn(() => null),
          saveSessionMetadata,
          markMainActiveResume,
          markMainActiveFresh: vi.fn(async () => {}),
        },
      },
    } as unknown as IpcDeps;

    await markMainActiveAfterTurn(deps, "hello", "user-keyboard");

    expect(saveSessionMetadata).toHaveBeenCalledWith("session-1", {
      sessionKind: "main",
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(markMainActiveResume).toHaveBeenCalledWith("session-1");
  });
});

describe("handleChatSessions row state", () => {
  it("carries the archived and unread marks the sidebar draws from", async () => {
    const listSessionsPage = vi.fn(() => [{
      id: "session-1",
      modifiedAt: new Date("2026-08-27T00:00:00Z"),
      title: "t",
      sessionKind: "main",
      archivedAt: "2026-08-27T01:00:00Z",
      unreadSince: "2026-08-27T02:00:00Z",
    }, {
      id: "session-2",
      modifiedAt: new Date("2026-08-27T00:00:00Z"),
      title: "u",
      sessionKind: "main",
    }]);
    const deps = {
      conversationLoop: { getSessionId: () => "session-1" },
      memoryManager: { sessions: { listSessionsPage } },
    } as unknown as IpcDeps;

    const { sessions } = await handleChatSessions(deps, { kind: "main" });
    expect(sessions[0]).toMatchObject({ id: "session-1", archivedAt: "2026-08-27T01:00:00Z", unreadSince: "2026-08-27T02:00:00Z" });
    expect(sessions[1]).not.toHaveProperty("archivedAt");
    expect(sessions[1]).not.toHaveProperty("unreadSince");
  });
});

describe("handleChatSessions project filters", () => {
  it("does not add a project filter when the caller requests the project sidebar list", async () => {
    const listSessionsPage = vi.fn(() => []);
    const deps = {
      conversationLoop: {
        getSessionId: () => "session-1",
      },
      memoryManager: { sessions: { listSessionsPage } },
    } as unknown as IpcDeps;

    expect(await handleChatSessions(deps, { kind: "main" })).toEqual({
      current: "session-1",
      sessions: [],
    });
    expect(listSessionsPage.mock.calls[0]?.[0]).not.toHaveProperty("projectRoot");
  });

  it("does not let an arbitrary renderer projectRoot widen the session scope", async () => {
    const listSessionsPage = vi.fn(() => []);
    const deps = {
      conversationLoop: {
        getSessionId: () => "session-1",
      },
      memoryManager: { sessions: { listSessionsPage } },
    } as unknown as IpcDeps;

    await handleChatSessions(deps, { kind: "main", projectRoot: "C:\\unapproved\\project" });

    expect(listSessionsPage.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: "__ave_unauthorized_project_root__",
    });
  });
});

describe("handleChatSessions legacy default-root metadata scrub", () => {
  // Legacy default tags must not create a separate named project in the sidebar.
  const DEFAULT_ROOT = "C:\\Users\\example\\.ave\\workspace";

  it("strips projectRoot/projectName from a legacy session tagged with the default workspace root", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(DEFAULT_ROOT);
    try {
      const listSessionsPage = vi.fn(() => [{
        id: "legacy-session",
        modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        title: "Legacy chat",
        sessionKind: "main" as const,
        projectRoot: DEFAULT_ROOT,
        projectName: "workspace",
      }]);
      const deps = {
        conversationLoop: { getSessionId: () => "legacy-session" },
        memoryManager: { sessions: { listSessionsPage } },
      } as unknown as IpcDeps;

      const result = await handleChatSessions(deps, { kind: "main" });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).not.toHaveProperty("projectRoot");
      expect(result.sessions[0]).not.toHaveProperty("projectName");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("keeps projectRoot/projectName for a session scoped to an explicit (non-default) project", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(DEFAULT_ROOT);
    try {
      const listSessionsPage = vi.fn(() => [{
        id: "explicit-session",
        modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        title: "Explicit chat",
        sessionKind: "main" as const,
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
      }]);
      const deps = {
        conversationLoop: { getSessionId: () => "explicit-session" },
        memoryManager: { sessions: { listSessionsPage } },
      } as unknown as IpcDeps;

      const result = await handleChatSessions(deps, { kind: "main" });

      expect(result.sessions[0]).toMatchObject({
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

describe("handleChatSessions federated families", () => {
  const main = {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    modifiedAt: new Date("2026-09-03T10:00:00Z"),
    title: "main chat",
    preview: "Main reply",
    sessionKind: "main",
  };
  const routine = {
    id: "session-routine",
    modifiedAt: new Date("2026-09-03T07:00:00Z"),
    title: "아침 브리핑",
    preview: "Routine reply",
    sessionKind: "routine",
    routineId: "rt-1",
    routineTitle: "아침 브리핑",
    routineFiredAt: "2026-09-03T07:00:00.000Z",
  };
  const sideChats = [
    {
      id: "side-1",
      modifiedAt: new Date("2026-09-03T10:30:00Z"),
      title: "환경 변수 확인",
      preview: "Side reply",
      sessionKind: "main",
      originSessionId: "aaaaaaaa-1111-4111-8111-111111111111",
    },
  ];
  const runs = [
    { id: "sub-a1", modifiedAt: new Date("2026-09-03T11:00:00Z"), title: "Execute: 월간 보고서", preview: "마지막 실행 결과", sessionKind: "subagent", workBoardItemId: 7 },
    { id: "sub-a0", modifiedAt: new Date("2026-09-03T09:00:00Z"), title: "Plan: 월간 보고서", sessionKind: "subagent", workBoardItemId: 7 },
    { id: "sub-gone", modifiedAt: new Date("2026-09-03T08:00:00Z"), title: "Execute: deleted", sessionKind: "subagent", workBoardItemId: 9 },
    { id: "sub-plain", modifiedAt: new Date("2026-09-03T12:00:00Z"), title: "a spawned agent", sessionKind: "subagent" },
  ];
  const ALL_FAMILIES = ["main", "routine", "work-board", "side-chat"] as const;
  const makeDeps = () => {
    const listWorkBoardRunSessions = vi.fn(() => runs);
    const get = vi.fn(async (id: number) => id === 7
      ? { status: "found" as const, itemId: 7, item: { id: 7, title: "월간 보고서 초안", projectRoot: "C:\\ws\\alpha", projectName: "alpha" } }
      : { status: "not_found" as const, itemId: id });
    const listSessionsPage = vi.fn(() => [main, routine]);
    const listSideChatSessionsPage = vi.fn(() => sideChats);
    const deps = {
      conversationLoop: { getSessionId: () => "aaaaaaaa-1111-4111-8111-111111111111" },
      memoryManager: { sessions: { listSessionsPage } },
      sideChatMemoryManager: { sessions: { listSessionsPage: listSideChatSessionsPage } },
      getSubAgentRunner: () => ({ listWorkBoardRunSessions, listSubAgentSessions: () => [{ ...runs[3], originSessionId: "aaaaaaaa-1111-4111-8111-111111111111", running: true }] }),
      workBoardStore: { get },
    } as unknown as IpcDeps;
    return { deps, listWorkBoardRunSessions, listSessionsPage, listSideChatSessionsPage, get };
  };

  it("carries the persisted child origin and live state through the list contract", async () => {
    const { deps } = makeDeps();
    const { sessions } = await handleChatSessions(deps, { families: ["subagent"] });
    expect(sessions).toEqual([expect.objectContaining({ id: "sub-plain", family: "subagent", originSessionId: "aaaaaaaa-1111-4111-8111-111111111111", running: true })]);
    expect(sessions[0]).not.toHaveProperty("parentSessionId");
  });

  it("stamps a family on every row and merges the four stores by time", async () => {
    const { deps, listWorkBoardRunSessions, listSessionsPage } = makeDeps();
    const { sessions } = await handleChatSessions(deps, { families: [...ALL_FAMILIES] });
    expect(listWorkBoardRunSessions).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    expect(listSessionsPage).toHaveBeenCalledWith(expect.objectContaining({ kind: "all" }));
    expect(sessions.map((s) => [s.id, s.family])).toEqual([
      ["sub-a1", "work-board"],
      ["side-1", "side-chat"],
      ["aaaaaaaa-1111-4111-8111-111111111111", "main"],
      ["session-routine", "routine"],
    ]);
  });

  it("retains summaries for every conversation family without loading a transcript", async () => {
    const { deps } = makeDeps();
    const { sessions } = await handleChatSessions(deps, { families: [...ALL_FAMILIES] });
    expect(sessions.map((session) => [session.family, session.preview])).toEqual([
      ["work-board", "마지막 실행 결과"],
      ["side-chat", "Side reply"],
      ["main", "Main reply"],
      ["routine", "Routine reply"],
    ]);
  });

  it("carries the item's title and project on a work-board row, one row per item", async () => {
    const { deps } = makeDeps();
    const { sessions } = await handleChatSessions(deps, { families: [...ALL_FAMILIES] });
    expect(sessions[0]).toMatchObject({
      id: "sub-a1",
      family: "work-board",
      title: "월간 보고서 초안",
      preview: "마지막 실행 결과",
      sessionKind: "subagent",
      workBoardItemId: 7,
      projectRoot: "C:\\ws\\alpha",
      projectName: "alpha",
      modifiedAt: "2026-09-03T11:00:00.000Z",
    });
    expect(sessions.some((s) => ["sub-a0", "sub-gone", "sub-plain"].includes(s.id))).toBe(false);
  });

  it("carries the conversation a side chat belongs to", async () => {
    const { deps } = makeDeps();
    const { sessions } = await handleChatSessions(deps, { families: [...ALL_FAMILIES] });
    expect(sessions.find((s) => s.id === "side-1")).toMatchObject({
      family: "side-chat",
      title: "환경 변수 확인",
      originSessionId: "aaaaaaaa-1111-4111-8111-111111111111",
    });
  });

  it("answers a family-less request from the main store alone, under its kind", async () => {
    const { deps, listWorkBoardRunSessions, listSideChatSessionsPage, listSessionsPage } = makeDeps();
    const { sessions } = await handleChatSessions(deps, { kind: "main" });
    expect(listSessionsPage).toHaveBeenCalledWith(expect.objectContaining({ kind: "main" }));
    expect(sessions.map((s) => s.id)).toEqual(["aaaaaaaa-1111-4111-8111-111111111111", "session-routine"]);
    expect(listWorkBoardRunSessions).not.toHaveBeenCalled();
    expect(listSideChatSessionsPage).not.toHaveBeenCalled();
  });

  it("reads only the stores whose family was asked for", async () => {
    const { deps, listWorkBoardRunSessions, listSideChatSessionsPage } = makeDeps();
    const { sessions } = await handleChatSessions(deps, { families: ["main"] });
    expect(sessions.map((s) => s.id)).toEqual(["aaaaaaaa-1111-4111-8111-111111111111"]);
    expect(listWorkBoardRunSessions).not.toHaveBeenCalled();
    expect(listSideChatSessionsPage).not.toHaveBeenCalled();
  });

  it("lists nothing extra when the runner, the board or the side-chat store is not wired", async () => {
    const deps = {
      conversationLoop: { getSessionId: () => "aaaaaaaa-1111-4111-8111-111111111111" },
      memoryManager: { sessions: { listSessionsPage: vi.fn(() => [main]) } },
    } as unknown as IpcDeps;
    const { sessions } = await handleChatSessions(deps, { families: [...ALL_FAMILIES] });
    expect(sessions.map((s) => s.id)).toEqual(["aaaaaaaa-1111-4111-8111-111111111111"]);
  });
});

describe("sidebar row pages", () => {
  it("continues limit-one cursors through mixed parent and child timestamps", async () => {
    const parent = { id: "aaaaaaaa-1111-4111-8111-111111111111", title: "Parent", sessionKind: "main" as const, modifiedAt: new Date("2026-11-09") };
    const middle = { ...parent, id: "bbbbbbbb-1111-4111-8111-111111111111", modifiedAt: new Date("2026-11-07") };
    const older = { ...parent, id: "cccccccc-1111-4111-8111-111111111111", modifiedAt: new Date("2026-11-05") };
    const child = { ...parent, id: "sub-aaaaaaaa-dddddddd-1111-4111-8111-111111111111", sessionKind: "subagent" as const, originSessionId: parent.id, modifiedAt: new Date("2026-11-01"), running: false };
    const readPage = <T extends { id: string; modifiedAt: Date }>(rows: T[], options: { limit: number; before?: Date; beforeId?: string }) => rows.filter((row) => !options.before || row.modifiedAt < options.before || row.modifiedAt.getTime() === options.before.getTime() && row.id < (options.beforeId ?? "")).slice(0, options.limit);
    const deps = {
      conversationLoop: { getSessionId: () => parent.id },
      memoryManager: { sessions: { listSessionsPage: (options: Parameters<typeof readPage>[1]) => readPage([parent, middle, older], options) } },
      getSubAgentRunner: () => ({ listSubAgentSessions: (options: Parameters<typeof readPage>[1]) => readPage([child], options) }),
    } as unknown as IpcDeps;
    const seen: string[] = [];
    let cursor: { before?: string; beforeId?: string } = {};
    for (let index = 0; index < 5; index += 1) {
      const result = await handleChatSessions(deps, { families: ["main", "subagent"], limit: 1, ...cursor });
      seen.push(...result.sessions.map((row) => row.id));
      const last = result.sessions.at(-1);
      if (!last) break;
      cursor = { before: last.modifiedAt, beforeId: last.id };
    }
    expect(seen).toEqual([parent.id, middle.id, older.id, child.id]);
  });

  it("loads only the same 100 summaries as the main listing among 5000 histories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-sidebar-summary-budget-"));
    try {
      const memoryManager = new MemoryManager({ aveDir: dir });
      for (let index = 0; index < 5000; index += 1) {
        const id = index.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
        writeFileSync(join(dir, "sessions", id + ".jsonl"), JSON.stringify({ role: "user", content: "History " + index }) + "\n");
      }
      const summaries = vi.spyOn(memoryManager.sessions as unknown as { readSessionSummary: (id: string) => { title: string; preview: string } }, "readSessionSummary");
      const deps = { memoryManager, conversationLoop: { getSessionId: () => "aaaaaaaa-1111-4111-8111-111111111111" } } as unknown as IpcDeps;
      await handleChatSessions(deps, { limit: 100 });
      const mainCalls = summaries.mock.calls.length;
      expect(mainCalls).toBe(100);
      summaries.mockClear();
      await handleChatSessions(deps, { families: ["main", "subagent"], limit: 100 });
      expect(summaries).toHaveBeenCalledTimes(mainCalls);
      summaries.mockRestore();
    } finally { await cleanupTmpDir(dir); }
  });
});
