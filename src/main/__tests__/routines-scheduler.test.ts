import { describe, it, expect, vi } from "vitest";
import { RoutinesScheduler } from "../routines-scheduler.js";
import { futureIso, tempRoutinesStore, pastIso } from "./routines-fixture.js";

describe("RoutinesScheduler — llm-session dispatch", () => {
  it("fires onLlmSession handler when llm-session routine is due", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "llm-session",
        schedule: { at: pastIso() },
        prePrompt: "test prompt",
        title: "test",
      });

      const scheduler = new RoutinesScheduler(store, async () => []);
      const fired: string[] = [];
      scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });

      await scheduler.checkAndFire();
      expect(fired).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("does not fire onNotification for llm-session routine", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "llm-session",
        schedule: { at: pastIso() },
        prePrompt: "test prompt",
      });

      const scheduler = new RoutinesScheduler(store, async () => []);
      const notifFired: string[] = [];
      scheduler.onNotification(({ routine }) => { notifFired.push(routine.id); });

      await scheduler.checkAndFire();
      expect(notifFired).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

describe("RoutinesScheduler — notification-only dispatch", () => {
  it("fires onNotification handler for notification-only routine", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: pastIso() },
        notificationTitle: "test notif",
      });

      const scheduler = new RoutinesScheduler(store, async () => []);
      const fired: string[] = [];
      scheduler.onNotification(({ routine }) => { fired.push(routine.id); });

      await scheduler.checkAndFire();
      expect(fired).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("does not fire onLlmSession for notification-only routine", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: pastIso() },
        notificationTitle: "test notif",
      });

      const scheduler = new RoutinesScheduler(store, async () => []);
      const llmFired: string[] = [];
      scheduler.onLlmSession(({ routine }) => { llmFired.push(routine.id); });

      await scheduler.checkAndFire();
      expect(llmFired).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

describe("RoutinesScheduler — future routine not fired", () => {
  it("does not fire routines scheduled in the future", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso() },
        notificationTitle: "future notif",
      });

      const scheduler = new RoutinesScheduler(store, async () => []);
      const fired: string[] = [];
      scheduler.onNotification(({ routine }) => { fired.push(routine.id); });

      await scheduler.checkAndFire();
      expect(fired).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

describe("RoutinesScheduler — markFired persistence", () => {
  it("updates lastFiredAt and dismisses one-shot routine after fire", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: pastIso(), repeat: { kind: "none" } },
        notificationTitle: "one-shot",
      });

      const scheduler = new RoutinesScheduler(store, async () => []);
      await scheduler.checkAndFire();

      // Routine should now be dismissed (one-shot)
      expect(store.listActive()).toHaveLength(0);
      expect(store.list()[0].lastFiredAt).toBeTruthy();
    } finally {
      await cleanup();
    }
  });
});

describe("RoutinesScheduler — dispatchNow (trigger-now IPC)", () => {
  it("dispatches routine immediately via dispatchNow", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso() }, // future — would not fire via normal tick
        notificationTitle: "manual trigger",
      });

      const scheduler = new RoutinesScheduler(store, async () => []);
      const fired: string[] = [];
      scheduler.onNotification(({ routine }) => { fired.push(routine.id); });

      const ok = await scheduler.dispatchNow(r.id);
      expect(ok).toBe(true);
      expect(fired).toContain(r.id);
    } finally {
      await cleanup();
    }
  });

  it("dispatchNow returns false for unknown id", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const scheduler = new RoutinesScheduler(store, async () => []);
      const ok = await scheduler.dispatchNow("nonexistent-id");
      expect(ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("dispatchNow updates lastFiredAt", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso(), repeat: { kind: "daily" } },
        notificationTitle: "daily triggered manually",
      });

      const scheduler = new RoutinesScheduler(store, async () => []);
      scheduler.onNotification(() => {});
      await scheduler.dispatchNow(r.id);

      const updated = store.list().find((x) => x.id === r.id);
      expect(updated?.lastFiredAt).toBeTruthy();
    } finally {
      await cleanup();
    }
  });
});

describe("RoutinesScheduler — per-tick error isolation", () => {
  it("checkAndFire resolves even when a handler throws", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: pastIso() },
        notificationTitle: "routine 1",
      });

      const scheduler = new RoutinesScheduler(store, async () => []);

      // Handler always throws — checkAndFire should still resolve (not reject).
      scheduler.onNotification(() => {
        throw new Error("simulated handler error");
      });

      // Promise must resolve (not reject) — per-handler errors are swallowed.
      await expect(scheduler.checkAndFire()).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("scheduled routine plugin availability", () => {
  const scope = (ids: string[]) => ({ pluginIds: { mode: "allow" as const, ids }, forcedPluginIds: [], directories: [] });

  it("keeps a missing one-shot pending across reload, then fires after installation", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const routine = await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "summarize", schedule: { at: pastIso() }, scope: scope(["absent-plugin"]) });
      let installed: string[] = [];
      const scheduler = new RoutinesScheduler(store, async () => installed);
      const fired = vi.fn();
      scheduler.onLlmSession(fired);
      await scheduler.checkAndFire();
      await store.load();
      expect(store.listActive()).toHaveLength(1);
      expect(store.list()[0]).toMatchObject({ lastSkippedReason: "plugins-missing", needsAttention: { missingPluginIds: ["absent-plugin"] } });
      expect(store.list()[0].lastFiredAt).toBeUndefined();
      expect(store.list()[0].lastRoutineSessionId).toBeUndefined();
      expect(fired).not.toHaveBeenCalled();
      expect(await scheduler.dispatchNow(routine.id)).toBe("plugins-missing");
      installed = ["absent-plugin"];
      await scheduler.checkAndFire();
      expect(fired).toHaveBeenCalledTimes(1);
      expect(store.list()[0].needsAttention).toBeUndefined();
      expect(store.list()[0].lastSkippedReason).toBeUndefined();
      expect(store.listActive()).toEqual([]);
    } finally { await cleanup(); }
  });

  it("runs a partial one-shot once and leaves its missing ids visible and removable", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      const routine = await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "summarize", schedule: { at: pastIso() }, scope: scope(["installed-plugin", "absent-plugin"]) });
      const scheduler = new RoutinesScheduler(store, async () => ["installed-plugin"]);
      const fired = vi.fn();
      scheduler.onLlmSession(fired);
      await scheduler.checkAndFire();
      await store.load();
      await scheduler.checkAndFire();
      expect(fired).toHaveBeenCalledTimes(1);
      expect(store.listActive()[0]).toMatchObject({ needsAttention: { missingPluginIds: ["absent-plugin"] } });
      expect(store.list()[0].lastFiredAt).toBeTruthy();
      expect(store.list()[0].lastSkippedReason).toBeUndefined();
      const copy = store.listActive()[0];
      copy.needsAttention!.missingPluginIds.push("unwanted-id");
      expect(store.listActive()[0].needsAttention?.missingPluginIds).toEqual(["absent-plugin"]);
      expect(await store.remove(routine.id)).toBe(true);
      expect(store.listActive()).toEqual([]);
    } finally { await cleanup(); }
  });

  it("advances skipped repeating occurrences without replacing an earlier result", async () => {
    const { store, cleanup } = tempRoutinesStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T09:00:00Z"));
    try {
      const routine = await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "summarize", schedule: { at: new Date().toISOString(), repeat: { kind: "daily" } }, scope: scope(["absent-plugin"]) });
      await store.update(routine.id, { lastFiredAt: "2026-09-25T09:00:00.000Z", lastRoutineSessionId: "previous-session" });
      const scheduler = new RoutinesScheduler(store, async () => []);
      await scheduler.checkAndFire();
      expect(store.list()[0]).toMatchObject({
        lastSkippedReason: "plugins-missing", lastFiredAt: "2026-09-25T09:00:00.000Z", lastRoutineSessionId: "previous-session",
        schedule: { at: "2026-09-27T09:00:00.000Z" },
      });
      const snapshot = store.list();
      await scheduler.checkAndFire();
      expect(store.list()).toEqual(snapshot);
    } finally { vi.useRealTimers(); await cleanup(); }
  });

  it("deduplicates a skipped cron minute after reload and clears the skip on the next successful fire", async () => {
    const { store, cleanup } = tempRoutinesStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T09:00:00Z"));
    try {
      await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "summarize", schedule: { repeat: { kind: "cron", expression: "* * * * *" } }, scope: scope(["installed-later"]) });
      let installed: string[] = [];
      const readInstalled = vi.fn(async () => installed);
      const scheduler = new RoutinesScheduler(store, readInstalled);
      const fired = vi.fn();
      scheduler.onLlmSession(fired);
      await scheduler.checkAndFire();
      await store.load();
      expect(store.list()[0].lastSkippedMinuteUTC).toBe("2026-09-26T09:00Z");
      expect(store.list()[0].lastFiredMinuteUTC).toBeUndefined();
      installed = ["installed-later"];
      await scheduler.checkAndFire();
      expect(readInstalled).toHaveBeenCalledTimes(1);
      expect(fired).not.toHaveBeenCalled();
      vi.setSystemTime(new Date("2026-09-26T09:01:00Z"));
      await scheduler.checkAndFire();
      expect(fired).toHaveBeenCalledTimes(1);
      expect(store.list()[0].needsAttention).toBeUndefined();
      expect(store.list()[0].lastSkippedMinuteUTC).toBeUndefined();
    } finally { vi.useRealTimers(); await cleanup(); }
  });

  it.each([undefined, { mode: "deny-all" as const }, { mode: "inherit" as const }, { mode: "allow" as const, ids: [] }])("does not require plugins for scope %j", async (pluginIds) => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "summarize", schedule: { at: pastIso() }, ...(pluginIds ? { scope: { pluginIds, forcedPluginIds: [], directories: [] } } : {}) });
      const readInstalled = vi.fn(async () => []);
      const scheduler = new RoutinesScheduler(store, readInstalled);
      const fired = vi.fn(); scheduler.onLlmSession(fired);
      await scheduler.checkAndFire();
      expect(fired).toHaveBeenCalledTimes(1);
      expect(readInstalled).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  it("does not gate notification-only routines on plugin availability", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      await store.add({ trigger: "schedule", execution: "notification-only", notificationTitle: "Notice", schedule: { at: pastIso() }, scope: scope(["absent-plugin"]) });
      const readInstalled = vi.fn(async () => []);
      const scheduler = new RoutinesScheduler(store, readInstalled);
      const fired = vi.fn(); scheduler.onNotification(fired);
      await scheduler.checkAndFire();
      expect(fired).toHaveBeenCalledTimes(1);
      expect(readInstalled).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  it("does not invent missing-plugin state or consume an occurrence on registry read failure", async () => {
    const { store, cleanup } = tempRoutinesStore();
    try {
      await store.add({ trigger: "schedule", execution: "llm-session", prePrompt: "summarize", schedule: { at: pastIso() }, scope: scope(["unknown-plugin"]) });
      const scheduler = new RoutinesScheduler(store, async () => { throw new Error("registry unavailable"); });
      const before = store.list(); const fired = vi.fn(); scheduler.onLlmSession(fired);
      await scheduler.checkAndFire();
      expect(store.list()).toEqual(before);
      expect(fired).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });
});
