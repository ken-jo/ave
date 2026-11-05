import { TEST_OWNER } from "./routines-fixture.js";
// Schedule panel store contract: project scope, creator, user edits, pause and resume.
import { withRoutinesStore } from "./support/routines-store.js";
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RoutinesStore } from "../routines-store.js";
import { RoutinesScheduler } from "../routines-scheduler.js";
import { futureIso, pastIso } from "./routines-fixture.js";

const HOUR = 60 * 60 * 1000;

describe("RoutinesStore — project scope and creator", () => {
  it("persists projectRoot and createdBy, and requires both on add", withRoutinesStore(async ({ store, dir }) => {
    const scoped = await store.add({
      trigger: "schedule",
      execution: "notification-only",
      schedule: { at: futureIso() },
      notificationTitle: "n",
      projectRoot: "/work/checkout",
      createdBy: "agent",
    });
    expect(scoped.projectRoot).toBe("/work/checkout");
    expect(scoped.createdBy).toBe("agent");
    const base = { trigger: "schedule" as const, execution: "notification-only" as const, schedule: { at: futureIso() }, notificationTitle: "m" };
    await expect(store.add({ ...base, createdBy: "user" } as never)).rejects.toThrow(/projectRoot/);
    await expect(store.add({ ...base, projectRoot: "  ", createdBy: "user" })).rejects.toThrow(/projectRoot/);
    await expect(store.add({ ...base, projectRoot: "/p" } as never)).rejects.toThrow(/createdBy/);
    const reloaded = new RoutinesStore(join(dir, "routines.json"));
    await reloaded.load();
    expect(reloaded.list().find((r) => r.id === scoped.id)).toMatchObject({ projectRoot: "/work/checkout", createdBy: "agent" });
  }));

  it("filters by project; only records stored before projects existed show in every project", withRoutinesStore(async ({ store, dir }) => {
    const a = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "notification-only", schedule: { at: futureIso() }, notificationTitle: "a", projectRoot: "/p/a" });
    await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "notification-only", schedule: { at: futureIso() }, notificationTitle: "b", projectRoot: "/p/b" });
    const file = join(dir, "routines.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.routines.push({ id: "legacy", trigger: "schedule", execution: "notification-only", notificationTitle: "legacy", schedule: { at: futureIso() }, createdAt: new Date().toISOString() });
    writeFileSync(file, JSON.stringify(raw));
    const reloaded = new RoutinesStore(file);
    await reloaded.load();
    const ids = reloaded.listForDisplay({ projectRoot: "/p/a/" }).routines.map((r) => r.id).sort();
    expect(ids).toEqual([a.id, "legacy"].sort());
  }));

  it("rejects a stored record with an unknown pausedBy", withRoutinesStore(async ({ store, dir }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "notification-only", schedule: { at: futureIso() }, notificationTitle: "x" });
    const file = join(dir, "routines.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.routines[0].pausedAt = new Date().toISOString();
    raw.routines[0].pausedBy = "plugin";
    writeFileSync(file, JSON.stringify(raw));
    const reloaded = new RoutinesStore(file);
    await reloaded.load();
    expect(reloaded.list().map((x) => x.id)).not.toContain(r.id);
  }));
});

describe("RoutinesStore — add refuses values a later read would drop", () => {
  it("refuses an unknown trigger or execution instead of accepting and later dropping it", withRoutinesStore(async ({ store }) => {
    const base = { ...TEST_OWNER, schedule: { at: futureIso() }, notificationTitle: "n" };
    await expect(store.add({ ...base, trigger: "hourly", execution: "notification-only" } as never)).rejects.toThrow(/trigger/);
    await expect(store.add({ ...base, trigger: "schedule", execution: "webhook" } as never)).rejects.toThrow(/execution/);
    expect(store.list()).toEqual([]);
  }));
});

describe("RoutinesStore — edit", () => {
  it("changes title, prompt and schedule with the same validation as add", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at: futureIso(), repeat: { kind: "daily" } }, prePrompt: "old", title: "Old" });
    const at = futureIso(3 * HOUR);
    const edited = await store.edit(r.id, { title: "New", prePrompt: "new prompt", schedule: { at, repeat: { kind: "weekly" } } });
    expect(edited).toMatchObject({ title: "New", prePrompt: "new prompt", schedule: { at, repeat: { kind: "weekly" } } });
    await expect(store.edit(r.id, { prePrompt: "  " })).rejects.toThrow(/prePrompt/);
    await expect(store.edit(r.id, { schedule: { repeat: { kind: "cron", expression: "nope" } } })).rejects.toThrow(/cron/);
    await expect(store.edit(r.id, { schedule: { repeat: { kind: "daily" } } })).rejects.toThrow(/schedule.at is required/);
    expect(store.list().find((x) => x.id === r.id)?.prePrompt).toBe("new prompt");
  }));

  it("clears the title with null and refuses a shutdown item's schedule", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at: futureIso() }, prePrompt: "p", title: "T" });
    expect((await store.edit(r.id, { title: null }))?.title).toBeUndefined();
    const s = await store.add({ ...TEST_OWNER, trigger: "shutdown", execution: "llm-session", prePrompt: "p" });
    await expect(store.edit(s.id, { schedule: { at: futureIso() } })).rejects.toThrow(/shutdown/);
  }));

  it("returns null for an unknown or dismissed item", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at: futureIso() }, prePrompt: "p" });
    await store.dismiss(r.id);
    expect(await store.edit(r.id, { title: "x" })).toBeNull();
    expect(await store.edit("missing", { title: "x" })).toBeNull();
  }));
});

describe("RoutinesStore — edit keeps the series honest", () => {
  it("a fired one-shot whose time is edited can fire again", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at: pastIso() }, prePrompt: "p" });
    await store.update(r.id, { lastFiredAt: pastIso(-60_000) });
    await store.edit(r.id, { schedule: { at: pastIso(), repeat: { kind: "none" } } });
    const scheduler = new RoutinesScheduler(store, async () => []);
    const fired: string[] = [];
    scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });
    await scheduler.checkAndFire();
    expect(fired).toEqual([r.id]);
  }));

  it("re-saving the same cron keeps its minute key; a new cron drops it", withRoutinesStore(async ({ store }) => {
    const schedule = { repeat: { kind: "cron" as const, expression: "0 9 * * *" } };
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule, prePrompt: "p" });
    await store.update(r.id, { lastFiredMinuteUTC: "2026-11-04T00:00Z" });
    expect((await store.edit(r.id, { title: "t", schedule }))?.lastFiredMinuteUTC).toBe("2026-11-04T00:00Z");
    expect((await store.edit(r.id, { schedule: { repeat: { kind: "cron", expression: "0 10 * * *" } } }))?.lastFiredMinuteUTC).toBeUndefined();
  }));
});

describe("RoutinesScheduler — state changed during a scan", () => {
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { opened, open };
  }

  it("does not fire an item paused while the plugin check was in flight", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at: pastIso() }, prePrompt: "p",
      scope: { pluginIds: { mode: "allow", ids: ["calendar"] }, forcedPluginIds: [], directories: [] } });
    const g = gate();
    const scheduler = new RoutinesScheduler(store, async () => { await g.opened; return ["calendar"]; });
    const fired: string[] = [];
    scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });
    const scan = scheduler.checkAndFire();
    await store.pause(r.id, "user");
    g.open();
    await scan;
    expect(fired).toEqual([]);
    expect(store.list()[0]?.lastFiredAt).toBeUndefined();
  }));

  it("does not fire a one-shot edited to a later time while the scan was in flight", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at: pastIso() }, prePrompt: "p",
      scope: { pluginIds: { mode: "allow", ids: ["calendar"] }, forcedPluginIds: [], directories: [] } });
    const g = gate();
    const scheduler = new RoutinesScheduler(store, async () => { await g.opened; return ["calendar"]; });
    const fired: string[] = [];
    scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });
    const scan = scheduler.checkAndFire();
    await store.edit(r.id, { schedule: { at: futureIso(HOUR) } });
    g.open();
    await scan;
    expect(fired).toEqual([]);
    expect(store.listActive().map((x) => x.id)).toEqual([r.id]);
  }));

  it("does not fire a one-shot twice when two passes overlap", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at: pastIso() }, prePrompt: "p" });
    const fired = await store.markFired(r.id, [], { scheduled: true });
    expect(fired).not.toBeNull();
    // A failed one-shot is restored from dismissal for review; it must still not be due again.
    await store.recordRunOutcome(r.id, fired!.lastFiredAt!, { ok: false, kind: "error", reason: "429" });
    expect(store.listActive().map((x) => x.id)).toEqual([r.id]);
    expect(await store.markFired(r.id, [], { scheduled: true })).toBeNull();
  }));
});

describe("RoutinesStore — pause and resume", () => {
  it("pause records who paused it; a paused item is not due and cannot be run now", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at: pastIso() }, prePrompt: "p" });
    const paused = await store.pause(r.id, "user");
    expect(paused?.pausedBy).toBe("user");
    expect(paused?.pausedAt).toBeTruthy();
    const scheduler = new RoutinesScheduler(store, async () => []);
    const fired: string[] = [];
    scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });
    await scheduler.checkAndFire();
    expect(fired).toEqual([]);
    expect(await scheduler.dispatchNow(r.id)).toBe("paused");
    expect(fired).toEqual([]);
  }));

  it("resume advances a repeating item past now so paused occurrences do not catch up", withRoutinesStore(async ({ store }) => {
    const at = new Date(Date.now() - 3 * 24 * HOUR).toISOString();
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at, repeat: { kind: "daily" } }, prePrompt: "p" });
    await store.pause(r.id, "user");
    const resumed = await store.resume(r.id);
    expect(resumed?.pausedAt).toBeUndefined();
    expect(resumed?.pausedBy).toBeUndefined();
    expect(Date.parse(resumed!.schedule!.at!)).toBeGreaterThan(Date.now());
    // The first daily slot strictly after now: three days back plus one.
    expect(Date.parse(resumed!.schedule!.at!) - Date.parse(at)).toBe(4 * 24 * HOUR);
  }));

  it("resume does not catch up an overdue one-shot; run-now still runs it", withRoutinesStore(async ({ store }) => {
    const at = pastIso();
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at }, prePrompt: "p" });
    await store.pause(r.id, "user");
    const resumed = await store.resume(r.id);
    expect(resumed?.schedule?.at).toBe(new Date(at).toISOString());
    expect(resumed?.resumedAt).toBeTruthy();
    const scheduler = new RoutinesScheduler(store, async () => []);
    const fired: string[] = [];
    scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });
    await scheduler.checkAndFire();
    expect(fired).toEqual([]);
    expect(await scheduler.dispatchNow(r.id)).toBe(true);
    expect(fired).toEqual([r.id]);
  }));

  it("a one-shot rescheduled after resume fires at its new time", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", schedule: { at: pastIso(-5_000) }, prePrompt: "p" });
    await store.pause(r.id, "user");
    await store.resume(r.id);
    await store.edit(r.id, { schedule: { at: new Date(Date.now() + 50).toISOString() } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const scheduler = new RoutinesScheduler(store, async () => []);
    const fired: string[] = [];
    scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });
    await scheduler.checkAndFire();
    expect(fired).toEqual([r.id]);
  }));
});

describe("RoutinesStore — a re-save that only looks different is not a new schedule", () => {
  it("re-saving a cron item with reordered keys does not fire the same minute twice", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", prePrompt: "p",
      schedule: { repeat: { kind: "cron", expression: "* * * * *" } } });
    const scheduler = new RoutinesScheduler(store, async () => []);
    const fired: string[] = [];
    scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });
    await scheduler.checkAndFire();
    // The same schedule, keys in another order and the expression padded.
    await store.edit(r.id, { schedule: { repeat: { expression: " * * * * * ", kind: "cron" } as never } });
    await scheduler.checkAndFire();
    expect(fired).toHaveLength(1);
  }));

  it("re-saving a just-fired cron with an `at` added or only its spacing changed does not fire the same minute twice", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", prePrompt: "p",
      schedule: { repeat: { kind: "cron", expression: "* * * * *" } } });
    const scheduler = new RoutinesScheduler(store, async () => []);
    const fired: string[] = [];
    scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });
    await scheduler.checkAndFire();
    // Cron ignores `at`, so adding one is not a new schedule.
    await store.edit(r.id, { schedule: { at: futureIso(HOUR), repeat: { kind: "cron", expression: "* * * * *" } } });
    await scheduler.checkAndFire();
    // Inner spacing is not a new schedule either.
    await store.edit(r.id, { schedule: { repeat: { kind: "cron", expression: "*  *   * *\t*" } } });
    await scheduler.checkAndFire();
    expect(fired).toHaveLength(1);
  }));

  it("re-saving a fired one-shot as {at, repeat: none} does not make it due again", withRoutinesStore(async ({ store }) => {
    const at = pastIso(-60_000);
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", prePrompt: "p", schedule: { at } });
    const fired = await store.markFired(r.id);
    await store.recordRunOutcome(r.id, fired!.lastFiredAt!, { ok: false, kind: "error", reason: "429" });
    const edited = await store.edit(r.id, { schedule: { repeat: { kind: "none" }, at: new Date(Date.parse(at)).toISOString().replace("Z", "+00:00") } });
    expect(edited?.lastFiredAt).toBe(fired!.lastFiredAt);
    const scheduler = new RoutinesScheduler(store, async () => []);
    const runs: string[] = [];
    scheduler.onLlmSession(({ routine }) => { runs.push(routine.id); });
    await scheduler.checkAndFire();
    expect(runs).toEqual([]);
  }));

  it("a one-shot given a new time after resume is no longer missed", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", prePrompt: "p", schedule: { at: pastIso(-60_000) } });
    await store.pause(r.id, "user");
    await store.resume(r.id);
    const edited = await store.edit(r.id, { schedule: { at: pastIso(-30_000) } });
    expect(edited?.resumedAt).toBeUndefined();
    const scheduler = new RoutinesScheduler(store, async () => []);
    const runs: string[] = [];
    scheduler.onLlmSession(({ routine }) => { runs.push(routine.id); });
    await scheduler.checkAndFire();
    expect(runs).toEqual([r.id]);
  }));

  it("run-now of an item dismissed while the plugin check was in flight does not fire", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", prePrompt: "p", schedule: { at: futureIso(HOUR) },
      scope: { pluginIds: { mode: "allow", ids: ["calendar"] }, forcedPluginIds: [], directories: [] } });
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    const scheduler = new RoutinesScheduler(store, async () => { await opened; return ["calendar"]; });
    const runs: string[] = [];
    scheduler.onLlmSession(({ routine }) => { runs.push(routine.id); });
    const now = scheduler.dispatchNow(r.id);
    await store.dismiss(r.id);
    open();
    expect(await now).toBe(false);
    expect(runs).toEqual([]);
  }));

  it("refuses a stored record whose title or schedule has the wrong shape", withRoutinesStore(async ({ store, dir }) => {
    await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", prePrompt: "p", schedule: { at: futureIso() } });
    const file = join(dir, "routines.json");
    for (const bad of [{ title: 7 }, { prePrompt: ["x"] }, { schedule: { at: 5 } }, { schedule: { repeat: { kind: "hourly" } } }, { schedule: "daily" }]) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      raw.routines = [{ ...raw.routines[0], id: "bad", ...bad }];
      writeFileSync(file, JSON.stringify(raw));
      const reloaded = new RoutinesStore(file);
      await reloaded.load();
      expect(reloaded.list(), JSON.stringify(bad)).toEqual([]);
    }
  }));
});

describe("RoutinesScheduler — runs in progress", () => {
  it("lists a run from its start until it stops", withRoutinesStore(async ({ store }) => {
    const scheduler = new RoutinesScheduler(store, async () => []);
    scheduler.markRunning("r1", "2026-11-05T00:00:00.000Z");
    expect(scheduler.runningNow()).toEqual([{ routineId: "r1", firedAt: "2026-11-05T00:00:00.000Z" }]);
    scheduler.markStopped("r1");
    expect(scheduler.runningNow()).toEqual([]);
  }));
});
