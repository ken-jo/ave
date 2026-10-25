import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlertKindDeclaration } from "../../plugins/public-contract.js";
import type { AlertSettings } from "../../shared/alerts-types.js";
import { RegistrationLedger, markPluginAbsent, resolveRegistration } from "../kinds.js";
import { clampTtl, effectiveVisibility, predecessorBlocks } from "../gate.js";
import { alertEventReaches, isAlertEvent } from "../events.js";

function kind(overrides: Partial<AlertKindDeclaration> = {}): AlertKindDeclaration {
  return {
    id: "reply",
    label: { en: "Reply" },
    defaultEnabled: true,
    visibility: "summary-only",
    osNotification: { defaultEnabled: true, body: { en: "Body" } },
    summary: { en: "A mail" },
    prompt: { en: "Help me" },
    ...overrides,
  };
}

const empty: AlertSettings = { osNotificationsEnabled: true, kinds: {} };

describe("resolveRegistration", () => {
  it("writes a fresh install's kinds at their declared defaults, unseen", () => {
    expect(resolveRegistration(empty, "fixturemail", [kind()], "install")?.kinds["fixturemail:reply"]).toEqual({
      enabled: true,
      osNotification: true,
      visibility: "summary-only",
      seenByUser: false,
    });
  });

  it("writes a kind first seen in an update off", () => {
    expect(resolveRegistration(empty, "fixturemail", [kind()], "update")?.kinds["fixturemail:reply"]).toMatchObject({
      enabled: false,
      osNotification: false,
    });
  });

  it("keeps an existing entry, and changes nothing when nothing changed", () => {
    const settings: AlertSettings = {
      osNotificationsEnabled: true,
      kinds: { "fixturemail:reply": { enabled: false, osNotification: true, visibility: "summary-only", seenByUser: true } },
    };
    expect(resolveRegistration(settings, "fixturemail", [kind()], "install")).toBeNull();
  });

  it("turns off and marks escalated an entry whose declared visibility went up, visited or not", () => {
    for (const seenByUser of [true, false]) {
      const settings: AlertSettings = {
        osNotificationsEnabled: true,
        kinds: { "fixturemail:reply": { enabled: true, osNotification: true, visibility: "summary-only", seenByUser } },
      };
      const next = resolveRegistration(settings, "fixturemail", [kind({ visibility: "user-visible" })], "update");
      expect(next?.kinds["fixturemail:reply"]).toEqual({
        enabled: false,
        osNotification: true,
        visibility: "user-visible",
        seenByUser: false,
        escalated: true,
      });
    }
  });

  it("leaves an entry alone when the declared visibility went down", () => {
    const settings: AlertSettings = {
      osNotificationsEnabled: true,
      kinds: { "fixturemail:reply": { enabled: true, osNotification: true, visibility: "user-visible", seenByUser: true } },
    };
    expect(resolveRegistration(settings, "fixturemail", [kind({ visibility: "silent" })], "update")).toBeNull();
  });

  it("keeps a repaired entry off and repaired through an escalation", () => {
    const settings: AlertSettings = {
      osNotificationsEnabled: true,
      kinds: {
        "fixturemail:reply": { enabled: false, osNotification: false, visibility: "silent", seenByUser: false, repaired: true },
      },
    };
    expect(resolveRegistration(settings, "fixturemail", [kind()], "update")?.kinds["fixturemail:reply"]).toMatchObject({
      enabled: false,
      repaired: true,
      escalated: true,
    });
  });

  it("marks an uninstalled plugin's entries absent, and a reinstall brings them back as they were", () => {
    const installed = resolveRegistration(empty, "fixturemail", [kind()], "install")!;
    const absent = markPluginAbsent(installed, "fixturemail", "0.12.0")!;
    expect(absent.kinds["fixturemail:reply"]!.absentSinceAppVersion).toBe("0.12.0");
    expect(markPluginAbsent(absent, "fixturemail", "0.13.0")).toBeNull();
    const back = resolveRegistration(absent, "fixturemail", [kind()], "install")!;
    expect(back.kinds["fixturemail:reply"]).toEqual(installed.kinds["fixturemail:reply"]);
  });
});

describe("RegistrationLedger", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ave-alerts-ledger-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("counts the plugins installed at first use as updates, and a new one as an install", async () => {
    const ledger = new RegistrationLedger(() => dir);
    await ledger.load(async () => ["fixturemail"]);
    expect(ledger.register("fixturemail")).toBe("update");
    expect(ledger.register("otherfixture")).toBe("install");
    expect(ledger.register("otherfixture")).toBe("update");
    await ledger.flush();

    const reloaded = new RegistrationLedger(() => dir);
    await reloaded.load(async () => { throw new Error("the stored ledger is read, not the install list"); });
    expect(reloaded.register("otherfixture")).toBe("update");
  });

  it("forgets an uninstalled plugin, so a reinstall is fresh", async () => {
    const ledger = new RegistrationLedger(() => dir);
    await ledger.load(async () => ["fixturemail"]);
    ledger.forget("fixturemail");
    await ledger.flush();
    expect(JSON.parse(await readFile(join(dir, "plugins.json"), "utf-8"))).toEqual({ version: 1, plugins: [] });
    expect(ledger.register("fixturemail")).toBe("install");
    await ledger.flush();
  });
});

describe("predecessorBlocks", () => {
  const hint = "ave";
  it.each([
    ["installed from the hinted source, not loaded", { sourceId: "ave", revoked: false }, false, true],
    ["installed with no bound source", { sourceId: null, revoked: false }, false, true],
    ["revoked but still loaded", { sourceId: "ave", revoked: true }, true, true],
    ["revoked and not loaded", { sourceId: "ave", revoked: true }, false, false],
    ["from an unrelated source, loaded", { sourceId: "elsewhere", revoked: false }, true, false],
    ["from an unrelated source, installed", { sourceId: "elsewhere", revoked: false }, false, false],
    ["not installed at all", null, false, false],
  ] as const)("%s", (_label, installed, loaded, blocks) => {
    expect(predecessorBlocks({ installed, loaded, sourceHint: hint })).toBe(blocks);
  });
});

describe("raise-time bounds", () => {
  it("clamps the lifetime to one minute through seven days, defaulting to a day", () => {
    expect(clampTtl(undefined)).toBe(24 * 60 * 60_000);
    expect(clampTtl(1)).toBe(60_000);
    expect(clampTtl(30 * 24 * 60 * 60_000)).toBe(7 * 24 * 60 * 60_000);
    expect(clampTtl("1h")).toBeNull();
    expect(clampTtl(Number.NaN)).toBeNull();
  });

  it("lets a raise lower the declared visibility and never raise it", () => {
    expect(effectiveVisibility("user-visible", "silent")).toBe("silent");
    expect(effectiveVisibility("summary-only", "user-visible")).toBe("summary-only");
    expect(effectiveVisibility("summary-only", undefined)).toBe("summary-only");
  });
});

describe("alert event delivery", () => {
  const grant = { plugins: [{ pluginId: "fixturemail", events: ["alert.raised"] }] };
  it("reaches the raising plugin, and another only with a grant naming it and the event", () => {
    const payload = { pluginId: "fixturemail", kind: "reply", alertId: "x" };
    expect(alertEventReaches("fixturemail", "alert.raised", payload, undefined)).toBe(true);
    expect(alertEventReaches("otherfixture", "alert.raised", payload, undefined)).toBe(false);
    expect(alertEventReaches("otherfixture", "alert.raised", payload, grant)).toBe(true);
    expect(alertEventReaches("otherfixture", "alert.withdrawn", payload, grant)).toBe(false);
  });

  it("reaches no plugin for a host kind or a payload without an owner", () => {
    expect(alertEventReaches("fixturemail", "alert.raised", { pluginId: "@host" }, undefined)).toBe(false);
    expect(alertEventReaches("fixturemail", "alert.raised", { pluginId: "@host" }, {
      plugins: [{ pluginId: "@host", events: ["alert.raised"] }],
    })).toBe(false);
    expect(alertEventReaches("fixturemail", "alert.raised", {}, grant)).toBe(false);
  });

  it("recognises the namespace", () => {
    expect(isAlertEvent("alert.raised")).toBe(true);
    expect(isAlertEvent("alerts.raised")).toBe(false);
  });
});
