// Persist source as idempotency identity and enforce its length at the tool boundary.
import { describe, it, expect } from "vitest";

import { createRoutineScheduleTool } from "../routine-schedule.js";
import {
  MAX_CRON_EXPR_LENGTH,
  MAX_ROUTINE_SOURCE_LENGTH,
  MIN_INTERVAL_MS,
} from "../../main/routines-store.js";
import { futureIso, tempRoutinesStore } from "../../main/__tests__/routines-fixture.js";
import { toolExecutionContext as ctx } from "./tool-context-fixture.js";

// A conversation in a project, as every routine_schedule call needs.
const ANY_PROJECT = { projectRootForSession: () => "/work/project", chatForSession: () => undefined, removeRoutine: async () => false };
const chatCtx = () => ({ ...ctx(), metadata: { sessionId: "chat" } });



describe("routine_schedule tool — source marker", () => {
  it("keeps plugin template attribution on an approval-gated schedule", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const tool = createRoutineScheduleTool(store, ANY_PROJECT);
      expect(tool.category).toBe("write");
      const result = await tool.execute({ execution: "llm-session", schedule: { at: futureIso() },
        prePrompt: "Write a draft", source: "agent-plugin:writer-plugin:daily" }, chatCtx());
      expect(result.isError).toBe(false);
      expect(store.list()[0]?.source).toBe("agent-plugin:writer-plugin:daily");
    } finally { await cleanup(); }
  });

  it("stamps the source marker onto the persisted routine", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const tool = createRoutineScheduleTool(store, ANY_PROJECT);
      const result = await tool.execute(
        {
          execution: "llm-session",
          schedule: { at: futureIso(), repeat: { kind: "daily" } },
          prePrompt: "야간 재스캔",
          source: "suggestion:local-indexer:nightly-rescan",
        },
        chatCtx(),
      );
      expect(result.isError).toBe(false);
      const routineId = JSON.parse(result.output).routineId as string;
      const record = store.list().find((r) => r.id === routineId);
      expect(record?.source).toBe("suggestion:local-indexer:nightly-rescan");
    } finally {
      await cleanup();
    }
  });

  it("leaves source unset when omitted", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const tool = createRoutineScheduleTool(store, ANY_PROJECT);
      const result = await tool.execute(
        {
          execution: "notification-only",
          schedule: { at: futureIso() },
          notificationTitle: "manual",
        },
        chatCtx(),
      );
      expect(result.isError).toBe(false);
      const routineId = JSON.parse(result.output).routineId as string;
      expect(store.list().find((r) => r.id === routineId)?.source).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("rejects a source longer than the cap with a clean tool error", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const tool = createRoutineScheduleTool(store, ANY_PROJECT);
      const result = await tool.execute(
        {
          execution: "notification-only",
          schedule: { at: futureIso() },
          notificationTitle: "too-long",
          source: "x".repeat(MAX_ROUTINE_SOURCE_LENGTH + 1),
        },
        chatCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("source must be at most");
      expect(store.list()).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

describe("routine_schedule tool — validation bounds shared with the store", () => {
  it("rejects a cron expression one character past the store's cap", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const tool = createRoutineScheduleTool(store, ANY_PROJECT);
      // Repeated minute entries preserve exact length; whitespace would be trimmed.
      const cronOfLength = (length: number): string => {
        let minutes = (length - " 9 * * 1".length) % 2 === 0 ? "00" : "0";
        while (minutes.length + " 9 * * 1".length < length) minutes += ",0";
        return `${minutes} 9 * * 1`;
      };
      const atCap = cronOfLength(MAX_CRON_EXPR_LENGTH);
      const pastCap = cronOfLength(MAX_CRON_EXPR_LENGTH + 1);
      expect(atCap).toHaveLength(MAX_CRON_EXPR_LENGTH);
      expect(pastCap).toHaveLength(MAX_CRON_EXPR_LENGTH + 1);
      const run = (expression: string) => tool.execute(
        { execution: "notification-only", schedule: { repeat: { kind: "cron", expression } }, notificationTitle: "cron" },
        chatCtx(),
      );
      expect((await run(atCap)).isError).toBe(false);
      expect((await run(pastCap)).isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("persists an interval at the store's minimum and drops one a millisecond under it", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const tool = createRoutineScheduleTool(store, ANY_PROJECT);
      const persistedRepeat = async (intervalMs: number) => {
        const result = await tool.execute(
          { execution: "notification-only", schedule: { at: futureIso(), repeat: { kind: "interval", intervalMs } }, notificationTitle: "interval" },
          chatCtx(),
        );
        expect(result.isError).toBe(false);
        const routineId = JSON.parse(result.output).routineId as string;
        return store.list().find((r) => r.id === routineId)?.schedule?.repeat;
      };
      expect(await persistedRepeat(MIN_INTERVAL_MS)).toEqual({ kind: "interval", intervalMs: MIN_INTERVAL_MS });
      expect(await persistedRepeat(MIN_INTERVAL_MS - 1)).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("routine_schedule tool — owner fields", () => {
  it("lists the item under the calling chat's project and records the agent as creator", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const tool = createRoutineScheduleTool(store, { ...ANY_PROJECT, projectRootForSession: (id) => (id === "chat-1" ? "/work/checkout" : undefined) });
      const result = await tool.execute({ execution: "llm-session", schedule: { at: futureIso() }, prePrompt: "p" },
        { ...ctx(), cwd: "/somewhere/else", metadata: { sessionId: "chat-1" } });
      expect(result.isError).toBe(false);
      expect(store.list()[0]).toMatchObject({ projectRoot: "/work/checkout", createdBy: "agent" });
    } finally { await cleanup(); }
  });

  it("refuses when the calling conversation has no project, instead of using the process cwd", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const tool = createRoutineScheduleTool(store, { ...ANY_PROJECT, projectRootForSession: () => undefined });
      for (const metadata of [{}, { sessionId: "chat-without-project" }]) {
        const result = await tool.execute({ execution: "llm-session", schedule: { at: futureIso() }, prePrompt: "p" },
          { ...ctx(), cwd: "/tmp", metadata });
        expect(result.isError).toBe(true);
      }
      expect(store.list()).toEqual([]);
    } finally { await cleanup(); }
  });
});

describe("routine_schedule tool — 대화에 연결 and this chat's items", () => {
  const CHAT = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1";
  const OTHER = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb2";
  const CHILD = "cccccccc-3333-4ccc-8ccc-ccccccccccc3";
  // The calling session's chat: a sub-agent of CHAT counts as CHAT; a session with no saved main chat has none.
  const deps = (removeRoutine = async (_id: string) => true) => ({
    projectRootForSession: () => "/work/project",
    chatForSession: (sessionId: string) => (sessionId === CHAT || sessionId === CHILD ? CHAT : undefined),
    removeRoutine,
  });
  const from = (sessionId: string) => ({ ...ctx(), metadata: { sessionId } });
  const daily = { at: futureIso(), repeat: { kind: "daily" } };

  it("connects to the calling chat only, never to a session the model names", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const tool = createRoutineScheduleTool(store, deps());
      const added = await tool.execute({ execution: "llm-session", schedule: daily, prePrompt: "check the build", connectToThisChat: true, targetSessionId: OTHER }, from(CHILD));
      expect(added.isError).toBe(false);
      expect(store.list()[0]).toMatchObject({ targetSessionId: CHAT, createdBy: "agent" });
      expect(JSON.parse(added.output)).toMatchObject({ connectedToThisChat: true });
      const plain = await tool.execute({ execution: "llm-session", schedule: daily, prePrompt: "x", targetSessionId: OTHER }, from(CHAT));
      expect(plain.isError).toBe(false);
      expect(store.list().find((r) => r.prePrompt === "x")?.targetSessionId).toBeUndefined();
    } finally { await cleanup(); }
  });

  it("refuses to connect a notification, or from a session with no saved chat", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const tool = createRoutineScheduleTool(store, deps());
      const notification = await tool.execute({ execution: "notification-only", schedule: daily, notificationTitle: "t", connectToThisChat: true }, from(CHAT));
      expect(notification.isError).toBe(true);
      const noChat = await tool.execute({ execution: "llm-session", schedule: daily, prePrompt: "p", connectToThisChat: true }, from(OTHER));
      expect(noChat.isError).toBe(true);
      expect(store.list()).toEqual([]);
    } finally { await cleanup(); }
  });

  it("updates an item connected to this chat, and refuses any other item", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const mine = await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "old", schedule: daily, targetSessionId: CHAT, projectRoot: "/work/project", createdBy: "user" } as never);
      const theirs = await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "theirs", schedule: daily, targetSessionId: OTHER, projectRoot: "/work/project", createdBy: "user" } as never);
      const unlinked = await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "free", schedule: daily, projectRoot: "/work/project", createdBy: "user" } as never);
      const tool = createRoutineScheduleTool(store, deps());
      const ok = await tool.execute({ action: "update", routineId: mine.id, prePrompt: "new", title: "Build" }, from(CHILD));
      expect(ok.isError).toBe(false);
      expect(store.list().find((r) => r.id === mine.id)).toMatchObject({ prePrompt: "new", title: "Build", targetSessionId: CHAT });
      for (const id of [theirs.id, unlinked.id, "no-such-item"]) {
        const refused = await tool.execute({ action: "update", routineId: id, prePrompt: "hijack" }, from(CHAT));
        expect(refused.isError).toBe(true);
        expect(JSON.parse(refused.output).error).toContain("connected to this chat");
      }
      expect(store.list().find((r) => r.id === theirs.id)?.prePrompt).toBe("theirs");
      expect((await tool.execute({ action: "update", prePrompt: "x" }, from(CHAT))).isError).toBe(true);
      // The model cannot move its item to another chat or cut it loose.
      const relink = await tool.execute({ action: "update", routineId: mine.id, targetSessionId: OTHER }, from(CHAT));
      expect(relink.isError).toBe(true);
    } finally { await cleanup(); }
  });

  it("removes an item connected to this chat through the host's removal, and refuses any other item", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const mine = await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "mine", schedule: daily, targetSessionId: CHAT, projectRoot: "/work/project", createdBy: "agent" } as never);
      const theirs = await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "theirs", schedule: daily, targetSessionId: OTHER, projectRoot: "/work/project", createdBy: "user" } as never);
      const removed: string[] = [];
      const tool = createRoutineScheduleTool(store, deps(async (id) => { removed.push(id); return true; }));
      expect((await tool.execute({ action: "remove", routineId: theirs.id }, from(CHAT))).isError).toBe(true);
      expect((await tool.execute({ action: "remove", routineId: mine.id }, from(CHAT))).isError).toBe(false);
      expect(removed).toEqual([mine.id]);
      expect((await tool.execute({ action: "rename", routineId: mine.id }, from(CHAT))).isError).toBe(true);
    } finally { await cleanup(); }
  });

  it("keys a remembered approval by the action and the connection", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const key = createRoutineScheduleTool(store, deps()).approvalCacheKey as (input: unknown) => string;
      expect(key({ execution: "llm-session" })).toBe("action:add:connect:no:scope:deny-all");
      expect(key({ execution: "llm-session", connectToThisChat: true, allowedPlugins: ["b-plugin", "a-plugin"] })).toBe("action:add:connect:this-chat:scope:allow:a-plugin,b-plugin");
      expect(key({ action: "update", routineId: "r1" })).toBe("action:update:connect:this-chat:item:r1");
      expect(key({ action: "remove", routineId: "r1" })).toBe("action:remove:connect:this-chat:item:r1");
      expect(key({ action: "rename" })).toBe("action:invalid");
    } finally { await cleanup(); }
  });
});
