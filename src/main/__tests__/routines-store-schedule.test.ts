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
  it("persists projectRoot and createdBy, and defaults createdBy to user", withRoutinesStore(async ({ store, dir }) => {
    const scoped = await store.add({
      trigger: "schedule",
      execution: "notification-only",
      schedule: { at: futureIso() },
      notificationTitle: "n",
      projectRoot: "/work/checkout",
    });
    const plain = await store.add({ trigger: "schedule", execution: "notification-only", schedule: { at: futureIso() }, notificationTitle: "m" });
    expect(scoped.projectRoot).toBe("/work/checkout");
    expect(scoped.createdBy).toBe("user");
    expect(plain.projectRoot).toBeUndefined();
    const reloaded = new RoutinesStore(join(dir, "routines.json"));
    await reloaded.load();
    expect(reloaded.list().find((r) => r.id === scoped.id)?.projectRoot).toBe("/work/checkout");
  }));

  it("filters by project and keeps unscoped items visible in every project", withRoutinesStore(async ({ store }) => {
    const a = await store.add({ trigger: "schedule", execution: "notification-only", schedule: { at: futureIso() }, notificationTitle: "a", projectRoot: "/p/a" });
    await store.add({ trigger: "schedule", execution: "notification-only", schedule: { at: futureIso() }, notificationTitle: "b", projectRoot: "/p/b" });
    const legacy = await store.add({ trigger: "schedule", execution: "notification-only", schedule: { at: futureIso() }, notificationTitle: "legacy" });
    const ids = store.listForDisplay({ projectRoot: "/p/a/" }).routines.map((r) => r.id).sort();
    expect(ids).toEqual([a.id, legacy.id].sort());
  }));

  it("rejects a stored record with an unknown pausedBy", withRoutinesStore(async ({ store, dir }) => {
    const r = await store.add({ trigger: "schedule", execution: "notification-only", schedule: { at: futureIso() }, notificationTitle: "x" });
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

describe("RoutinesStore — edit", () => {
  it("changes title, prompt and schedule with the same validation as add", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ trigger: "schedule", execution: "llm-session", schedule: { at: futureIso(), repeat: { kind: "daily" } }, prePrompt: "old", title: "Old" });
    const at = futureIso(3 * HOUR);
    const edited = await store.edit(r.id, { title: "New", prePrompt: "new prompt", schedule: { at, repeat: { kind: "weekly" } } });
    expect(edited).toMatchObject({ title: "New", prePrompt: "new prompt", schedule: { at, repeat: { kind: "weekly" } } });
    await expect(store.edit(r.id, { prePrompt: "  " })).rejects.toThrow(/prePrompt/);
    await expect(store.edit(r.id, { schedule: { repeat: { kind: "cron", expression: "nope" } } })).rejects.toThrow(/cron/);
    await expect(store.edit(r.id, { schedule: { repeat: { kind: "daily" } } })).rejects.toThrow(/schedule.at is required/);
    expect(store.list().find((x) => x.id === r.id)?.prePrompt).toBe("new prompt");
  }));

  it("clears the title with null and refuses a shutdown item's schedule", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ trigger: "schedule", execution: "llm-session", schedule: { at: futureIso() }, prePrompt: "p", title: "T" });
    expect((await store.edit(r.id, { title: null }))?.title).toBeUndefined();
    const s = await store.add({ trigger: "shutdown", execution: "llm-session", prePrompt: "p" });
    await expect(store.edit(s.id, { schedule: { at: futureIso() } })).rejects.toThrow(/shutdown/);
  }));

  it("returns null for an unknown or dismissed item", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ trigger: "schedule", execution: "llm-session", schedule: { at: futureIso() }, prePrompt: "p" });
    await store.dismiss(r.id);
    expect(await store.edit(r.id, { title: "x" })).toBeNull();
    expect(await store.edit("missing", { title: "x" })).toBeNull();
  }));
});

describe("RoutinesStore — pause and resume", () => {
  it("pause records who paused it; a paused item is not due and cannot be run now", withRoutinesStore(async ({ store }) => {
    const r = await store.add({ trigger: "schedule", execution: "llm-session", schedule: { at: pastIso() }, prePrompt: "p" });
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
    const r = await store.add({ trigger: "schedule", execution: "llm-session", schedule: { at, repeat: { kind: "daily" } }, prePrompt: "p" });
    await store.pause(r.id, "user");
    const resumed = await store.resume(r.id);
    expect(resumed?.pausedAt).toBeUndefined();
    expect(resumed?.pausedBy).toBeUndefined();
    expect(Date.parse(resumed!.schedule!.at!)).toBeGreaterThan(Date.now());
    // The first daily slot strictly after now: three days back plus one.
    expect(Date.parse(resumed!.schedule!.at!) - Date.parse(at)).toBe(4 * 24 * HOUR);
  }));

  it("resume keeps a past one-shot due once, as the app-off catch-up rule does", withRoutinesStore(async ({ store }) => {
    const at = pastIso();
    const r = await store.add({ trigger: "schedule", execution: "llm-session", schedule: { at }, prePrompt: "p" });
    await store.pause(r.id, "user");
    const resumed = await store.resume(r.id);
    expect(resumed?.schedule?.at).toBe(new Date(at).toISOString());
    const scheduler = new RoutinesScheduler(store, async () => []);
    const fired: string[] = [];
    scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });
    await scheduler.checkAndFire();
    expect(fired).toEqual([r.id]);
  }));
});
