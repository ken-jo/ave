import { createAlertMigrationPorts } from "../../__tests__/support/alert-migration.js";
/**
 * The raise pipeline end to end: one result code per step, in order; windows
 * charged only on acceptance; the card, the cue, the audit row and the event
 * after it; and the identity lifecycle across withdrawal, the user's answer,
 * expiry, uninstall and a restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "../../audit/audit-logger.js";
import type { PluginManifest } from "../../plugins/public-contract.js";
import type { AlertCard, AlertSettings } from "../../shared/alerts-types.js";
import { normalizeAlertSettings } from "../../data/settings-normalization.js";
import { parseStagedEnvelope } from "../../shared/staged-origins.js";
import { AlertsService } from "../service.js";

type Json = Record<string, unknown>;

const MINUTE = 60_000;

const KINDS: Json[] = [
  {
    id: "reply",
    label: { en: "Mail needing a reply" },
    defaultEnabled: true,
    visibility: "user-visible",
    osNotification: { defaultEnabled: true, body: { en: "A mail needs your reply." } },
    actionLabel: { en: "Draft a reply" },
    slots: { subject: { kind: "text", maxLength: 40 }, emailId: { kind: "ref" } },
    summary: { en: "Reply to: {subject}" },
    prompt: { en: "Help me reply to {subject}." },
  },
  {
    id: "digest",
    label: { en: "New mail" },
    defaultEnabled: true,
    visibility: "summary-only",
    osNotification: { defaultEnabled: false, body: { en: "New mail arrived." } },
    summary: { en: "New mail" },
    prompt: { en: "Show me the new mail." },
  },
  {
    id: "quiet",
    label: { en: "Background note" },
    defaultEnabled: true,
    visibility: "silent",
    summary: { en: "Noted" },
    prompt: { en: "Nothing to do." },
  },
  {
    id: "urgent",
    label: { en: "Meeting starting" },
    defaultEnabled: true,
    visibility: "user-visible",
    osNotification: { defaultEnabled: true, bypassFocusGate: true, body: { en: "A meeting is starting." } },
    summary: { en: "A meeting is starting" },
    prompt: { en: "Open the meeting." },
  },
  {
    id: "loudsummary",
    label: { en: "Urgent mail" },
    defaultEnabled: true,
    visibility: "summary-only",
    osNotification: { defaultEnabled: true, bypassFocusGate: true, body: { en: "Urgent mail arrived." } },
    summary: { en: "Urgent mail" },
    prompt: { en: "Show me the urgent mail." },
  },
  {
    id: "offbydefault",
    label: { en: "Rare" },
    defaultEnabled: false,
    visibility: "user-visible",
    summary: { en: "Rare" },
    prompt: { en: "Rare." },
  },
  {
    id: "successor",
    label: { en: "Inherited" },
    defaultEnabled: true,
    visibility: "user-visible",
    summary: { en: "Inherited" },
    prompt: { en: "Inherited." },
    inherits: [
      {
        pluginId: "retiredfixture",
        sourceId: "ave",
        enabled: { key: "disabledDetectors", listed: "disabled", values: ["successor"] },
      },
    ],
  },
];

function manifest(kinds: Json[] = KINDS): Pick<PluginManifest, "alerts"> {
  return { alerts: { reasoning: "Tells you about mail.", kinds } } as unknown as Pick<PluginManifest, "alerts">;
}

function burstKinds(count: number): Json[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `burst${i}`,
    label: { en: `Burst ${i}` },
    defaultEnabled: true,
    visibility: "silent",
    summary: { en: "Burst" },
    prompt: { en: "Burst." },
  }));
}

interface Harness {
  service: AlertsService;
  settings: () => AlertSettings;
  shown: AlertCard[];
  dismissed: string[];
  fired: Array<{ title: string; body: string; bypassFocusGate?: boolean; sticky?: boolean }>;
  events: Array<{ type: string; payload: Json }>;
  audits: AuditEntry[];
  clock: { now: number };
  focused: { value: boolean };
  blocks: ReturnType<typeof vi.fn>;
  changed: ReturnType<typeof vi.fn>;
}

let dir: string;
let sharedSettings: AlertSettings;
const services: AlertsService[] = [];

async function harness(options: { installed?: string[]; beforeSettingsWrite?: () => Promise<void> } = {}): Promise<Harness> {
  const h = {
    shown: [] as AlertCard[],
    dismissed: [] as string[],
    fired: [] as Harness["fired"],
    events: [] as Harness["events"],
    audits: [] as AuditEntry[],
    clock: { now: 1_000_000 },
    focused: { value: false },
    blocks: vi.fn(async () => false),
    changed: vi.fn(),
  };
  const service = new AlertsService({
    migration: createAlertMigrationPorts(),
    dir: () => dir,
    settings: {
      get: () => structuredClone(sharedSettings),
      set: async (next) => {
        await options.beforeSettingsWrite?.();
        sharedSettings = structuredClone(next);
      },
    },
    installedPluginIds: async () => options.installed ?? [],
    appVersion: "0.12.0",
    locale: () => "en",
    predecessorBlocks: h.blocks,
    overlay: {
      show: (card) => { h.shown.push(card); },
      dismiss: (id) => { h.dismissed.push(id); },
    },
    notifications: {
      isFocusGateActive: () => h.focused.value,
      fire: (opts) => { h.fired.push(opts); },
    },
    emit: (type, payload) => { h.events.push({ type, payload }); },
    audit: (entry) => { h.audits.push(entry); },
    kindsChanged: h.changed,
    now: () => h.clock.now,
  });
  services.push(service);
  await service.load();
  return { ...h, service, settings: () => sharedSettings };
}

async function registered(options: { installed?: string[] } = {}): Promise<Harness> {
  const h = await harness(options);
  await h.service.register("fixturemail", manifest());
  return h;
}

const reply = (key = "mail-1", extra: Json = {}) => ({
  kind: "reply",
  key,
  slots: { subject: "Budget", emailId: "AAMk1" },
  ...extra,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ave-alerts-service-"));
  sharedSettings = { osNotificationsEnabled: true, kinds: {} };
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.flush();
  await rm(dir, { recursive: true, force: true });
});

describe("grant and shape", () => {
  it("refuses a kind the plugin did not declare", async () => {
    const h = await registered();
    expect(await h.service.raise("fixturemail", { kind: "nope", key: "k" })).toEqual({ status: "kind_not_granted", kind: "nope" });
  });

  it("fails loudly for a plugin whose kinds were never registered", async () => {
    const h = await harness();
    await expect(h.service.raise("fixturemail", reply())).rejects.toThrow(/before its kinds were registered/);
  });

  it.each([
    ["a key with a space", reply("mail 1"), "key"],
    ["a missing required slot", { kind: "reply", key: "k", slots: { emailId: "AAMk1" } }, "slots.subject"],
    ["an undeclared slot", reply("k", { slots: { subject: "s", emailId: "e", extra: "x" } }), "slots.extra"],
    ["a priority outside the three", reply("k", { priority: "urgent" }), "priority"],
    ["a visibility outside the three", reply("k", { visibility: "loud" }), "visibility"],
    ["a lifetime that is not a number", reply("k", { ttlMs: "1h" }), "ttlMs"],
  ])("names the field for %s, and delivers nothing", async (_label, input, field) => {
    const h = await registered();
    expect(await h.service.raise("fixturemail", input as never)).toEqual({ status: "invalid", field });
    expect(h.shown).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("accepts a 200-character key", async () => {
    const h = await registered();
    expect((await h.service.raise("fixturemail", reply(`AAMk${"a".repeat(196)}`))).status).toBe("raised");
  });
});

describe("predecessor and toggle", () => {
  it("refreshes predecessor presentation when the revocation feed changes", async () => {
    const h = await registered();
    h.changed.mockClear();
    h.service.setRevokedPlugins(["retiredfixture"]);
    expect(h.changed).toHaveBeenCalledOnce();
    h.service.setRevokedPlugins([]);
    expect(h.changed).toHaveBeenCalledTimes(2);
  });

  it("refuses a raise revoked while predecessor lookup is pending, and allows a later unrevoked raise", async () => {
    const h = await registered();
    let release!: (value: boolean) => void;
    h.blocks.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const pending = h.service.raise("fixturemail", { kind: "successor", key: "race" });
    await vi.waitFor(() => expect(h.blocks).toHaveBeenCalled());
    h.service.setRevokedPlugins(["fixturemail"]);
    release(false);
    expect(await pending).toEqual({ status: "kind_not_granted", kind: "successor" });
    expect(h.shown).toEqual([]);
    h.service.setRevokedPlugins([]);
    expect((await h.service.raise("fixturemail", { kind: "successor", key: "race" })).status).toBe("raised");
  });

  it("stays silent while the kind's predecessor blocks, and asks about it by name and source hint", async () => {
    const h = await registered();
    h.blocks.mockResolvedValue(true);
    expect(await h.service.raise("fixturemail", { kind: "successor", key: "k" }))
      .toEqual({ status: "blocked_by_predecessor", pluginId: "retiredfixture" });
    expect(h.blocks).toHaveBeenCalledWith("retiredfixture", "ave");
    expect(h.shown).toEqual([]);
    expect(h.audits.at(-1)?.input).toContain("alert.suppressed kind=successor reason=blocked_by_predecessor");
    h.blocks.mockResolvedValue(false);
    expect((await h.service.raise("fixturemail", { kind: "successor", key: "k" })).status).toBe("raised");
  });

  it("does not ask about a predecessor for a kind that inherits from none", async () => {
    const h = await registered();
    await h.service.raise("fixturemail", reply());
    expect(h.blocks).not.toHaveBeenCalled();
  });

  it("refuses a kind the user has off, auditing it once per window", async () => {
    const h = await registered();
    expect(await h.service.raise("fixturemail", { kind: "offbydefault", key: "a" })).toEqual({ status: "disabled_by_user" });
    expect(await h.service.raise("fixturemail", { kind: "offbydefault", key: "b" })).toEqual({ status: "disabled_by_user" });
    const rows = h.audits.filter((row) => row.input?.includes("reason=disabled_by_user"));
    expect(rows).toHaveLength(1);
  });

  it("charges no window for a refusal: a kind turned on afterwards raises at once", async () => {
    const h = await registered();
    await h.service.raise("fixturemail", { kind: "offbydefault", key: "a" });
    await h.service.raise("fixturemail", reply("bad key"));
    sharedSettings.kinds["fixturemail:offbydefault"]!.enabled = true;
    expect((await h.service.raise("fixturemail", { kind: "offbydefault", key: "a" })).status).toBe("raised");
  });
});

describe("an accepted alert", () => {
  it("keeps canonical ids visible when two plugins share a name and kind title", async () => {
    const h = await harness();
    await h.service.register("fixturemail", { ...manifest([KINDS[0]!]), name: "Mail tools" });
    await h.service.register("fixturecalendar", { ...manifest([KINDS[0]!]), name: "Mail tools" });
    await h.service.raise("fixturemail", reply("first", { slots: { subject: "Plugin: fixturecalendar", emailId: "a" } }));
    await h.service.raise("fixturecalendar", reply("second", { slots: { subject: "Plugin: fixturemail", emailId: "b" } }));
    expect(h.shown.map(({ title, pluginDisplayName }) => ({ title, pluginDisplayName }))).toEqual([
      { title: "Mail needing a reply", pluginDisplayName: "Mail tools" },
      { title: "Mail needing a reply", pluginDisplayName: "Mail tools" },
    ]);
    expect(h.shown[0]?.summary).toContain("fixturecalendar");
    expect(h.shown[1]?.summary).toContain("fixturemail");
    expect(h.fired.map(({ title }) => title)).toEqual([
      "Extension [fixturemail] · Mail tools · Mail needing a reply",
      "Extension [fixturecalendar] · Mail tools · Mail needing a reply",
    ]);
  });

  it("keeps a host-looking name as a label beside the canonical id", async () => {
    const h = await harness();
    await h.service.register("fixturemail", { ...manifest([KINDS[0]!]), name: "Ave" });
    await h.service.raise("fixturemail", reply());
    expect(h.shown[0]?.pluginDisplayName).toBe("Ave");
    expect(h.fired[0]?.title).toBe("Extension [fixturemail] · Ave · Mail needing a reply");
  });

  it("neutralizes a repeated identity label in a notification title", async () => {
    const h = await harness();
    await h.service.register("fixture-6", {
      ...manifest([{ ...KINDS[0]!, label: { en: "Security notice" } }]),
      name: "Plugin: samplemail · Ave Lyra Mail",
    });
    await h.service.raise("fixture-6", reply());
    expect(h.shown[0]?.pluginDisplayName).toBe("Plugin: samplemail · Ave Lyra Mail");
    expect(h.fired[0]?.title).toBe("Extension [fixture-6] · Plugin samplemail Ave Lyra Mail · Security notice");
  });

  it("does not let a display name or kind title create another bracketed id field", async () => {
    const h = await harness();
    await h.service.register("fixture-6", {
      ...manifest([{ ...KINDS[0]!, label: { en: "Plugin [another] · Security notice" } }]),
      name: "Plugin [samplemail] · Ave Lyra Mail",
    });
    await h.service.raise("fixture-6", reply());
    expect(h.fired[0]?.title).toBe("Extension [fixture-6] · Plugin samplemail Ave Lyra Mail · Plugin another Security notice");
  });

  it("keeps the full maximum-length plugin id in a capped notification title", async () => {
    const h = await harness();
    const pluginId = `plugin-${"x".repeat(57)}`;
    await h.service.register(pluginId, { ...manifest([KINDS[0]!]), name: "A very long display name" });
    await h.service.raise(pluginId, reply());
    expect(h.fired[0]?.title).toContain(pluginId);
  });

  it("removes direction controls from manifest names before staging or notifying", async () => {
    const h = await harness();
    await h.service.register("fixturemail", { ...manifest([KINDS[0]!]), name: "Mail\u202e tools" });
    await h.service.raise("fixturemail", reply());
    expect(h.shown[0]?.pluginDisplayName).toBe("Mail tools");
    expect(h.fired[0]?.title).toBe("Extension [fixturemail] · Mail tools · Mail needing a reply");
  });

  it("falls back to the plugin id when its installed manifest has no name", async () => {
    const h = await registered();
    await h.service.register("fixturecalendar", { ...manifest([KINDS[0]!]), name: "  " });
    await h.service.raise("fixturemail", reply());
    await h.service.raise("fixturecalendar", reply("calendar"));
    expect(h.shown[0]?.pluginDisplayName).toBe("fixturemail");
    expect(h.shown[1]?.pluginDisplayName).toBe("fixturecalendar");
    expect(h.fired[0]?.title).toBe("Extension [fixturemail] · Mail needing a reply");
    expect(h.fired[1]?.title).toBe("Extension [fixturecalendar] · Mail needing a reply");
  });

  it("completes queued acceptance when the current window send fails once", async () => {
    const h = await registered();
    vi.spyOn(h.shown, "push").mockImplementationOnce(() => { throw new Error("window destroyed"); });
    const result = await h.service.raise("fixturemail", reply());
    expect(result).toMatchObject({ status: "raised", delivered: { card: true, osNotification: true } });
    const alertId = (result as { alertId: string }).alertId;
    expect(h.shown).toEqual([]);
    expect(h.service.listOpen()).toHaveLength(1);
    expect(h.service.listOpen()[0]?.source.alertId).toBe(alertId);
    expect(h.fired).toHaveLength(1);
    expect(h.events).toEqual([expect.objectContaining({ type: "alert.raised", payload: expect.objectContaining({ alertId }) })]);
    expect(h.audits.at(-1)?.input).toContain(`alert.raised kind=reply alertId=${alertId}`);
    await h.service.flush();
    expect(JSON.parse(await readFile(join(dir, "open.json"), "utf8")).open).toEqual([
      expect.objectContaining({ alertId }),
    ]);
    expect(await h.service.raise("fixturemail", reply())).toEqual({ status: "refreshed", alertId });
    expect(h.shown).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(h.fired).toHaveLength(1);
    expect(await h.service.raise("fixturemail", reply("mail-2"))).toEqual({ status: "cooldown" });
  });

  it("stages a card rendered by the host, then audits and announces it without the key or slots", async () => {
    const h = await registered();
    const result = await h.service.raise("fixturemail", reply("secret-subject-key", { priority: "high" }));
    expect(result).toMatchObject({ status: "raised", delivered: { card: true } });
    const alertId = (result as { alertId: string }).alertId;
    expect(h.shown).toHaveLength(1);
    const card = h.shown[0]!;
    expect(card).toMatchObject({
      id: `alert:${alertId}`,
      source: { kind: "alert", pluginId: "fixturemail", kindId: "reply", alertId },
      title: "Mail needing a reply",
      summary: "Reply to: Budget",
      primaryActionLabel: "Draft a reply",
      priority: "high",
      running: false,
    });
    expect(card.pendingPrompt).toContain('source="overlay:fixturemail--reply"');
    expect(card.pendingPrompt).toContain("<untrusted-subject>Budget</untrusted-subject>");
    expect(card.pendingPrompt).toContain("- emailId: <untrusted-emailId>AAMk1</untrusted-emailId>");

    expect(h.events).toEqual([{
      type: "alert.raised",
      payload: {
        pluginId: "fixturemail",
        kind: "reply",
        alertId,
        visibility: "user-visible",
        priority: "high",
        raisedAt: new Date(h.clock.now).toISOString(),
      },
    }]);
    expect(h.audits.at(-1)?.input).toContain(`alert.raised kind=reply alertId=${alertId}`);

    await h.service.flush();
    const leaked = [JSON.stringify(h.events), JSON.stringify(h.audits), await readFile(join(dir, "open.json"), "utf-8")];
    for (const text of leaked) {
      expect(text).not.toContain("secret-subject-key");
      expect(text).not.toContain("Budget");
    }
  });

  it("still answers when the audit log throws", async () => {
    const h = await registered();
    const audit = vi.spyOn(h.audits, "push").mockImplementation(() => { throw new Error("audit down"); });
    expect((await h.service.raise("fixturemail", reply())).status).toBe("raised");
    expect(await h.service.raise("fixturemail", { kind: "offbydefault", key: "o" })).toEqual({ status: "disabled_by_user" });
    audit.mockRestore();
  });

  it("serves its card to a window that appears later, until the card is gone", async () => {
    const h = await registered();
    const { alertId } = (await h.service.raise("fixturemail", reply())) as { alertId: string };
    expect(h.service.listOpen().map((card) => card.id)).toEqual([`alert:${alertId}`]);
    h.service.cardClosed(alertId, "dismissed");
    expect(h.service.listOpen()).toEqual([]);
  });
});

describe("open and closed identities", () => {
  it.each([MINUTE, MINUTE + 1])("expires the identity at +%i ms before refreshing, without waiting for the sweep", async (elapsed) => {
    const h = await registered();
    const first = await h.service.raise("fixturemail", reply("mail-1", { ttlMs: MINUTE }));
    expect(first.status).toBe("raised");
    const { alertId } = first as { alertId: string };
    h.clock.now += elapsed;
    expect(await h.service.raise("fixturemail", reply())).toEqual({ status: "cooldown" });
    expect(h.service.listOpen()).toEqual([]);
    expect(h.dismissed).toEqual([`alert:${alertId}`]);
    expect(h.events.at(-1)).toEqual({
      type: "alert.withdrawn",
      payload: { pluginId: "fixturemail", kind: "reply", alertId, reason: "expired" },
    });
    await h.service.flush();
    expect(JSON.parse(await readFile(join(dir, "open.json"), "utf8")).open).toEqual([]);
    h.service.sweep();
    expect(h.events).toHaveLength(2);
    h.clock.now += 5 * MINUTE;
    expect((await h.service.raise("fixturemail", reply())).status).toBe("raised");
  });

  it("completes expiry and normal gating when the current window cannot dismiss the expired card", async () => {
    const h = await registered();
    await h.service.raise("fixturemail", reply("mail-1", { ttlMs: MINUTE }));
    vi.spyOn(h.dismissed, "push").mockImplementationOnce(() => { throw new Error("window destroyed"); });
    h.clock.now += MINUTE + 1;
    expect(await h.service.raise("fixturemail", reply())).toEqual({ status: "cooldown" });
    expect(h.service.listOpen()).toEqual([]);
    expect(h.events.at(-1)?.payload.reason).toBe("expired");
  });

  it("refreshes an open identity in place: no cue, no cooldown charge, a bounded budget", async () => {
    const h = await registered();
    const first = (await h.service.raise("fixturemail", reply())) as { alertId: string };
    const cues = h.fired.length;
    h.clock.now += 4 * MINUTE;
    expect(await h.service.raise("fixturemail", reply("mail-1", { slots: { subject: "Budget v2", emailId: "AAMk1" } })))
      .toEqual({ status: "refreshed", alertId: first.alertId });
    expect(h.shown.at(-1)?.summary).toBe("Reply to: Budget v2");
    expect(h.fired).toHaveLength(cues);
    // The cooldown runs from the first raise, not the refresh.
    h.clock.now += MINUTE + 1;
    expect((await h.service.raise("fixturemail", reply("mail-2"))).status).toBe("raised");

    for (let i = 0; i < 5; i += 1) expect((await h.service.raise("fixturemail", reply())).status).toBe("refreshed");
    expect(await h.service.raise("fixturemail", reply())).toEqual({ status: "rate_limited" });
  });

  it("keeps a dismissed identity closed for its lifetime, across a restart", async () => {
    const h = await registered();
    const { alertId } = (await h.service.raise("fixturemail", reply("mail-1", { ttlMs: 60 * MINUTE }))) as { alertId: string };
    expect(h.service.cardClosed(alertId, "dismissed")).toBe(true);
    expect(h.events.at(-1)).toEqual({
      type: "alert.withdrawn",
      payload: { pluginId: "fixturemail", kind: "reply", alertId, reason: "dismissed" },
    });
    h.clock.now += 10 * MINUTE;
    expect(await h.service.raise("fixturemail", reply())).toEqual({ status: "closed" });
    await h.service.flush();

    const restarted = await harness();
    restarted.clock.now = h.clock.now;
    await restarted.service.register("fixturemail", manifest());
    expect(await restarted.service.raise("fixturemail", reply())).toEqual({ status: "closed" });
    restarted.clock.now += 60 * MINUTE;
    expect((await restarted.service.raise("fixturemail", reply())).status).toBe("raised");
  });

  it("closes an accepted identity too, and says so", async () => {
    const h = await registered();
    const { alertId } = (await h.service.raise("fixturemail", reply())) as { alertId: string };
    h.service.cardClosed(alertId, "accepted");
    expect(h.events.at(-1)?.payload.reason).toBe("accepted");
    expect(await h.service.raise("fixturemail", reply())).toEqual({ status: "closed" });
  });

  it("keeps the level an identity opened at: a card-less alert gains no card when raised again", async () => {
    const h = await registered();
    await h.service.raise("fixturemail", reply("mail-1", { visibility: "silent" }));
    expect((await h.service.raise("fixturemail", reply())).status).toBe("refreshed");
    expect(h.shown).toEqual([]);
  });

  it("draws a card lost to a restart again when its open identity is raised", async () => {
    const h = await registered();
    await h.service.raise("fixturemail", reply());
    await h.service.flush();
    const restarted = await harness();
    restarted.clock.now = h.clock.now + MINUTE;
    await restarted.service.register("fixturemail", manifest());
    expect(restarted.service.listOpen()).toEqual([]);
    expect((await restarted.service.raise("fixturemail", reply())).status).toBe("refreshed");
    expect(restarted.service.listOpen()).toHaveLength(1);
  });

  it("lets a card-less identity live for its lifetime, refreshing without delivery, then expire", async () => {
    const h = await registered();
    h.focused.value = true;
    const { alertId } = (await h.service.raise("fixturemail", { kind: "digest", key: "d", ttlMs: 2 * MINUTE })) as { alertId: string };
    expect(h.fired).toHaveLength(1);
    expect((await h.service.raise("fixturemail", { kind: "digest", key: "d", visibility: "user-visible", ttlMs: 2 * MINUTE })).status)
      .toBe("refreshed");
    expect(h.fired).toHaveLength(1);
    expect(h.shown).toEqual([]);
    h.clock.now += 3 * MINUTE;
    h.service.sweep();
    expect(h.events.at(-1)).toEqual({
      type: "alert.withdrawn",
      payload: { pluginId: "fixturemail", kind: "digest", alertId, reason: "expired" },
    });
    h.clock.now += 3 * MINUTE;
    expect((await h.service.raise("fixturemail", { kind: "digest", key: "d" })).status).toBe("raised");
  });

  it("evicts the lowest priority, then the oldest, past three open cards of a kind", async () => {
    const h = await registered();
    const ids: string[] = [];
    for (const [key, priority] of [["a", "low"], ["b", "normal"], ["c", "normal"]] as const) {
      ids.push(((await h.service.raise("fixturemail", reply(key, { priority }))) as { alertId: string }).alertId);
      h.clock.now += 5 * MINUTE;
    }
    await h.service.raise("fixturemail", reply("d"));
    expect(h.dismissed).toEqual([`alert:${ids[0]}`]);
    expect(h.events.find((event) => event.type === "alert.withdrawn")?.payload).toMatchObject({ alertId: ids[0], reason: "evicted" });
    h.clock.now += 5 * MINUTE;
    await h.service.raise("fixturemail", reply("e"));
    expect(h.dismissed.at(-1)).toBe(`alert:${ids[1]}`);
  });
});

describe("budgets", () => {
  it("allows one raise per kind per cooldown window", async () => {
    const h = await registered();
    await h.service.raise("fixturemail", reply("a"));
    expect(await h.service.raise("fixturemail", reply("b"))).toEqual({ status: "cooldown" });
    expect((await h.service.raise("fixturemail", { kind: "digest", key: "x" })).status).toBe("raised");
    h.clock.now += 5 * MINUTE;
    expect((await h.service.raise("fixturemail", reply("b"))).status).toBe("raised");
  });

  it("caps raises per plugin per minute, apart from any other plugin", async () => {
    const h = await harness();
    await h.service.register("fixtureburst", manifest(burstKinds(7)));
    await h.service.register("fixturemail", manifest());
    for (let i = 0; i < 6; i += 1) {
      expect((await h.service.raise("fixtureburst", { kind: `burst${i}`, key: "k" })).status).toBe("raised");
    }
    expect(await h.service.raise("fixtureburst", { kind: "burst6", key: "k" })).toEqual({ status: "rate_limited" });
    expect((await h.service.raise("fixturemail", reply())).status).toBe("raised");
    h.clock.now += MINUTE + 1;
    expect((await h.service.raise("fixtureburst", { kind: "burst6", key: "k" })).status).toBe("raised");
  });
});

describe("visibility and cues", () => {
  it("identifies each plugin in focused summary toasts even when display names match", async () => {
    const h = await harness();
    h.focused.value = true;
    await h.service.register("fixturemail", { ...manifest([KINDS[1]!]), name: "Mail tools" });
    await h.service.register("fixturecalendar", { ...manifest([KINDS[1]!]), name: "Mail tools" });
    await h.service.raise("fixturemail", { kind: "digest", key: "mail" });
    await h.service.raise("fixturecalendar", { kind: "digest", key: "calendar" });
    expect(h.fired.map(({ title }) => title)).toEqual([
      "Extension [fixturemail] · Mail tools · New mail",
      "Extension [fixturecalendar] · Mail tools · New mail",
    ]);
  });

  it("routes the three levels: a card, a toast while focused, or only the record", async () => {
    const h = await registered();
    h.focused.value = true;
    expect(await h.service.raise("fixturemail", reply())).toMatchObject({ delivered: { card: true, toast: false, osNotification: false } });
    expect(await h.service.raise("fixturemail", { kind: "digest", key: "d" })).toMatchObject({ delivered: { card: false, toast: true, osNotification: false } });
    expect(await h.service.raise("fixturemail", { kind: "quiet", key: "q" })).toMatchObject({ delivered: { card: false, toast: false, osNotification: false } });
    expect(h.shown).toHaveLength(1);
    expect(h.fired).toEqual([{ kind: "alert", title: "Extension [fixturemail] · New mail", body: "New mail arrived." }]);
    expect(h.events.map((event) => event.payload.visibility)).toEqual(["user-visible", "summary-only", "silent"]);
  });

  it("lets a raise lower the level and never raise it", async () => {
    const h = await registered();
    expect(await h.service.raise("fixturemail", reply("a", { visibility: "silent" }))).toMatchObject({ delivered: { card: false } });
    expect(await h.service.raise("fixturemail", { kind: "digest", key: "d", visibility: "user-visible" })).toMatchObject({ delivered: { card: false } });
    expect(h.shown).toEqual([]);
  });

  it("notifies the OS for an unfocused window when the kind and both switches allow it", async () => {
    const h = await registered();
    expect(await h.service.raise("fixturemail", reply())).toMatchObject({ delivered: { osNotification: true } });
    expect(h.fired).toEqual([{ kind: "alert", title: "Extension [fixturemail] · Mail needing a reply", body: "A mail needs your reply." }]);
  });

  it("never notifies the OS for a low priority alert", async () => {
    const h = await registered();
    expect(await h.service.raise("fixturemail", reply("a", { priority: "low" }))).toMatchObject({ delivered: { osNotification: false } });
    expect(h.fired).toEqual([]);
  });

  it("needs the master switch and the kind's own OS toggle", async () => {
    const h = await registered();
    sharedSettings.osNotificationsEnabled = false;
    await h.service.raise("fixturemail", reply("a"));
    sharedSettings.osNotificationsEnabled = true;
    sharedSettings.kinds["fixturemail:urgent"]!.osNotification = false;
    await h.service.raise("fixturemail", { kind: "urgent", key: "u" });
    expect(h.fired).toEqual([]);
  });

  it("toasts a summary-only kind while focused even with its OS toggle off", async () => {
    const h = await registered();
    h.focused.value = true;
    expect(sharedSettings.kinds["fixturemail:digest"]!.osNotification).toBe(false);
    await h.service.raise("fixturemail", { kind: "digest", key: "d" });
    expect(h.fired).toHaveLength(1);
  });

  it("keeps a high priority toast until the user dismisses it", async () => {
    const h = await registered();
    h.focused.value = true;
    await h.service.raise("fixturemail", { kind: "digest", key: "d", priority: "high" });
    expect(h.fired[0]).toMatchObject({ sticky: true });
  });

  it("stays quiet for a focused window unless the kind bypasses the focus gate", async () => {
    const h = await registered();
    h.focused.value = true;
    await h.service.raise("fixturemail", reply());
    expect(h.fired).toEqual([]);
    expect(await h.service.raise("fixturemail", { kind: "urgent", key: "u" })).toMatchObject({ delivered: { osNotification: true } });
    expect(h.fired).toEqual([{ kind: "alert", title: "Extension [fixturemail] · Meeting starting", body: "A meeting is starting.", bypassFocusGate: true }]);
  });

  it("gives one cue at most: the OS notification replaces the toast when both would fire", async () => {
    const h = await registered();
    h.focused.value = true;
    expect(await h.service.raise("fixturemail", { kind: "loudsummary", key: "l" }))
      .toMatchObject({ delivered: { toast: false, osNotification: true } });
    expect(h.fired).toEqual([{ kind: "alert", title: "Extension [fixturemail] · Urgent mail", body: "Urgent mail arrived.", bypassFocusGate: true }]);
  });

  it("fires nothing for a refusal", async () => {
    const h = await registered();
    await h.service.raise("fixturemail", reply());
    await h.service.raise("fixturemail", reply("b"));
    await h.service.raise("fixturemail", { kind: "offbydefault", key: "o" });
    expect(h.fired).toHaveLength(1);
  });
});

describe("withdrawal and uninstall", () => {
  it("leaves incumbent settings untouched while a candidate is prepared and discarded", async () => {
    const h = await registered();
    const before = structuredClone(h.settings());
    const candidate = h.service.prepareRegistration("fixturemail", manifest([
      { ...KINDS[2], visibility: "user-visible" },
      { ...KINDS[0], id: "replacement" },
    ]));
    expect((await h.service.raise("fixturemail", reply())).status).toBe("raised");
    expect(h.settings()).toEqual(before);
    candidate.unpublish();
    expect((await h.service.raise("fixturemail", reply())).status).toBe("refreshed");
    expect(h.settings()).toEqual(before);
  });

  it("withdraws only the caller's own alert, and a withdrawn identity can open again", async () => {
    const h = await registered();
    await h.service.register("otherfixture", manifest());
    const { alertId } = (await h.service.raise("fixturemail", reply())) as { alertId: string };
    expect(await h.service.withdraw("otherfixture", "reply", "mail-1")).toBe(false);
    expect(await h.service.withdraw("fixturemail", "reply", "mail-2")).toBe(false);
    expect(await h.service.withdraw("fixturemail", "reply", "mail-1")).toBe(true);
    expect(h.dismissed).toEqual([`alert:${alertId}`]);
    expect(h.events.at(-1)?.payload).toMatchObject({ alertId, reason: "withdrawn" });
    h.clock.now += 5 * MINUTE;
    expect((await h.service.raise("fixturemail", reply())).status).toBe("raised");
  });

  it("keeps cards through a re-registration, as a config restart or an update does", async () => {
    const h = await registered();
    await h.service.raise("fixturemail", reply());
    await h.service.register("fixturemail", manifest());
    expect(h.service.listOpen()).toHaveLength(1);
    expect(h.dismissed).toEqual([]);
  });

  it("removes an uninstalled plugin's cards, keeps its choices marked absent, and treats a reinstall as fresh", async () => {
    const h = await registered({ installed: ["fixturemail"] });
    expect(sharedSettings.kinds["fixturemail:reply"]!.enabled).toBe(false);
    sharedSettings.kinds["fixturemail:reply"]!.enabled = true;
    const { alertId } = (await h.service.raise("fixturemail", reply())) as { alertId: string };
    await h.service.pluginUninstalled("fixturemail");
    expect(h.dismissed).toEqual([`alert:${alertId}`]);
    expect(h.events.at(-1)?.payload).toMatchObject({ alertId, reason: "withdrawn" });
    expect(sharedSettings.kinds["fixturemail:reply"]).toMatchObject({ enabled: true, absentSinceAppVersion: "0.12.0" });
    await expect(h.service.raise("fixturemail", reply())).rejects.toThrow(/before its kinds were registered/);

    await h.service.register("fixturemail", manifest([...KINDS, { ...KINDS[1], id: "latecomer" }]));
    expect(sharedSettings.kinds["fixturemail:reply"]).toEqual({
      enabled: true, osNotification: false, visibility: "user-visible", seenByUser: false,
    });
    // A kind the reinstall brings is a fresh install's: its declared default.
    expect(sharedSettings.kinds["fixturemail:latecomer"]!.enabled).toBe(true);
  });

  it("writes a plugin installed before the service existed as an update: its kinds start off", async () => {
    const h = await registered({ installed: ["fixturemail"] });
    expect(sharedSettings.kinds["fixturemail:reply"]).toMatchObject({ enabled: false, seenByUser: false });
    expect(await h.service.raise("fixturemail", reply())).toEqual({ status: "disabled_by_user" });
  });
});

describe("Settings choices", () => {
  it("lists declarations, plugin labels, choices and live predecessor blocking", async () => {
    const h = await harness();
    await h.service.register("fixturemail", { ...manifest(), name: "Fixture Mail" });
    h.blocks.mockResolvedValue(true);
    const rows = await h.service.listKinds();
    expect(rows.find((row) => row.kindKey === "fixturemail:successor")).toMatchObject({
      pluginLabel: "Fixture Mail", reasoning: "Tells you about mail.",
      blockedByPredecessor: "retiredfixture", choice: { seenByUser: false },
    });
    rows[0]!.choice.enabled = false;
    rows[0]!.declaration.label.en = "changed outside service";
    expect((await h.service.listKinds())[0]).toMatchObject({
      choice: { enabled: true }, declaration: { label: { en: "Mail needing a reply" } },
    });
    await h.service.pluginUninstalled("fixturemail");
    expect(await h.service.listKinds()).toEqual([]);
    expect(h.changed).toHaveBeenCalledTimes(2);
  });

  it("clears repair, escalation and the new mark only through explicit consent", async () => {
    sharedSettings = normalizeAlertSettings({ kinds: { "fixturemail:reply": { enabled: "damaged" } } });
    const h = await registered();
    expect(sharedSettings.kinds["fixturemail:reply"]).toMatchObject({
      enabled: false, seenByUser: false, repaired: true, escalated: true,
    });
    expect(await h.service.setKind("fixturemail:reply", { enabled: true })).toMatchObject({
      choice: { enabled: true, osNotification: false, visibility: "user-visible", seenByUser: true },
    });
    expect(sharedSettings.kinds["fixturemail:reply"]).not.toHaveProperty("repaired");
    expect(sharedSettings.kinds["fixturemail:reply"]).not.toHaveProperty("escalated");
    expect(normalizeAlertSettings(sharedSettings)).toEqual(sharedSettings);
    await h.service.register("fixturemail", manifest());
    expect((await h.service.raise("fixturemail", reply())).status).toBe("raised");
  });

  it("lets a user visit a blocked kind without enabling it or losing that choice at registration", async () => {
    const h = await registered();
    h.blocks.mockResolvedValue(true);
    expect(await h.service.setKind("fixturemail:successor", { enabled: false })).toMatchObject({
      blockedByPredecessor: "retiredfixture", choice: { enabled: false, seenByUser: true },
    });
    expect(await h.service.setKind("fixturemail:offbydefault", {})).toMatchObject({
      choice: { enabled: false, seenByUser: true },
    });
    await h.service.register("fixturemail", manifest());
    h.blocks.mockResolvedValue(false);
    expect(await h.service.raise("fixturemail", { kind: "successor", key: "a" })).toEqual({ status: "disabled_by_user" });
  });

  it.each([null, [], { enabled: 1 }, { osNotification: "true" }, { visibility: "silent" },
    { repaired: true }, { escalated: true }, { seenByUser: false }, { absentSinceAppVersion: "1.0.0" },
    { enabled: true, extra: false }])("refuses invalid or service-owned patch fields: %j", async (patch) => {
    const h = await registered();
    const before = structuredClone(sharedSettings);
    const changes = h.changed.mock.calls.length;
    expect(await h.service.setKind("fixturemail:reply", patch)).toEqual({ ok: false, error: "invalid-arguments" });
    expect(sharedSettings).toEqual(before);
    expect(h.changed).toHaveBeenCalledTimes(changes);
  });

  it("refuses unknown kinds, malformed keys and an undeclared OS cue", async () => {
    const h = await registered();
    expect(await h.service.setKind("fixturemail:unknown", {})).toEqual({ ok: false, error: "kind-not-registered" });
    expect(await h.service.setKind("unknown:reply", {})).toEqual({ ok: false, error: "kind-not-registered" });
    expect(await h.service.setKind("fixturemail:reply:extra", {})).toEqual({ ok: false, error: "invalid-arguments" });
    expect(await h.service.setKind("fixturemail:quiet", { osNotification: true })).toEqual({ ok: false, error: "invalid-arguments" });
  });

  it("keeps concurrent per-kind changes and the master switch without charging a delivery window", async () => {
    const h = await harness({ beforeSettingsWrite: async () => { await Promise.resolve(); } });
    await h.service.register("fixturemail", manifest());
    await Promise.all([
      h.service.setKind("fixturemail:reply", { enabled: false }),
      h.service.setKind("fixturemail:offbydefault", { enabled: true }),
      h.service.setOsNotificationsEnabled(false),
    ]);
    expect(sharedSettings.osNotificationsEnabled).toBe(false);
    expect(sharedSettings.kinds["fixturemail:reply"]!.enabled).toBe(false);
    expect(sharedSettings.kinds["fixturemail:offbydefault"]!.enabled).toBe(true);
    expect(await h.service.setOsNotificationsEnabled("true")).toEqual({ ok: false, error: "invalid-arguments" });
    expect((await h.service.raise("fixturemail", { kind: "offbydefault", key: "a" })).status).toBe("raised");
  });
});

describe("host kinds", () => {
  it("starts off, registers without plugins, and preserves host identity while staging a valid source", async () => {
    const h = await harness();
    await h.service.registerHostKinds();
    expect(await h.service.listKinds()).toMatchObject([{
      kindKey: "@host:due-soon", pluginId: "@host", pluginLabel: "Built-in",
      choice: { enabled: false, osNotification: false, seenByUser: false },
      blockedByPredecessor: null,
    }]);
    const input = { kind: "due-soon", key: "7:2026-09-26T01:00:00.000Z", slots: { title: "Finish report", itemId: "7" } };
    expect(await h.service.raise("@host", input)).toEqual({ status: "disabled_by_user" });
    await h.service.setKind("@host:due-soon", { enabled: true, osNotification: true });
    const result = await h.service.raise("@host", input);
    expect(result).toMatchObject({ status: "raised", delivered: { card: true, osNotification: true } });
    const card = h.shown[0]!;
    expect(card.source).toMatchObject({ pluginId: "@host", kindId: "due-soon" });
    expect(card.summary).toBe("Due soon: Finish report");
    expect(card.pendingPrompt).toContain("- itemId: <untrusted-itemId>7</untrusted-itemId>");
    expect(parseStagedEnvelope(card.pendingPrompt)).toMatchObject({ source: "overlay:host--due-soon", kind: { inputOrigin: "plugin-emitted" } });
    expect(h.events.at(-1)?.payload.pluginId).toBe("@host");
    expect(h.fired[0]?.body).toBe("A Work Board item is due within 24 hours.");
    expect(h.blocks).not.toHaveBeenCalled();
    expect(await h.service.withdraw("work-board", "due-soon", input.key)).toBe(false);
    expect(h.service.listOpen()).toHaveLength(1);
  });
});
