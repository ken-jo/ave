/**
 * The boot step that builds the alerts pipeline: its predecessor answer comes
 * from the installed packages, the loaded plugins and the revocation feed;
 * its cards go to the live main window; and an uninstall anywhere in the host
 * reaches it through `plugin.uninstalled`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupAlerts } from "../alerts-setup.js";
import { emitEvent } from "../../types.js";
import { revocationRegistry } from "../../../plugins/revocation/revocation-registry.js";
import { OVERLAY_V1 } from "../../../shared/ipc-channels.js";
import type { AlertSettings } from "../../../shared/alerts-types.js";
import type { BootContext } from "../../context.js";

const kinds = [
  {
    id: "reply",
    label: { en: "Mail needing a reply" },
    defaultEnabled: true,
    visibility: "user-visible",
    summary: { en: "A mail" },
    prompt: { en: "Help me answer." },
    inherits: [{
      pluginId: "retiredfixture",
      sourceId: "ave",
      enabled: { key: "disabledDetectors", listed: "disabled", values: ["reply"] },
    }],
  },
];

type Row = { name: string; version: string | null; sourceId: string | null; originCommit: string | null };

let home: string;
let previousHome: string | undefined;
let settings: AlertSettings;
let installed: Row[];
let loaded: string[];
const disposers: Array<() => void> = [];

function context() {
  const send = vi.fn();
  const ctx = {
    settingsService: {
      get: vi.fn(() => structuredClone(settings)),
      set: vi.fn(async (_key: string, next: AlertSettings) => { settings = structuredClone(next); }),
    },
    pluginMarketplace: { listInstalledPackages: vi.fn(async () => installed) },
    pluginRuntime: { listPluginIds: vi.fn(() => loaded) },
    bootAuditLogger: { log: vi.fn() },
    notificationService: { isFocusGateActive: () => false, fire: vi.fn() },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
  } as unknown as BootContext;
  return { ctx, send };
}

async function raiseReply(ctx: BootContext) {
  await ctx.alertsService.register("fixturemail", { alerts: { reasoning: "Mail.", kinds } } as never);
  return ctx.alertsService.raise("fixturemail", { kind: "reply", key: "mail-1" });
}

beforeEach(() => {
  previousHome = process.env.AVE_HOME;
  home = mkdtempSync(join(tmpdir(), "ave-alerts-setup-"));
  process.env.AVE_HOME = home;
  settings = { osNotificationsEnabled: true, kinds: {} };
  installed = [];
  loaded = [];
  revocationRegistry.replace([]);
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  revocationRegistry.resetForTesting();
  if (previousHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("setupAlerts", () => {
  it("blocks a successor while its predecessor from the hinted source is installed and not revoked", async () => {
    installed = [{ name: "retiredfixture", version: "1.0.0", sourceId: "ave", originCommit: null }];
    const { ctx } = context();
    disposers.push(await setupAlerts(ctx));
    expect(await raiseReply(ctx)).toEqual({ status: "blocked_by_predecessor", pluginId: "retiredfixture" });
    await ctx.alertsService.flush();
  });

  it("stops blocking once the installed predecessor is revoked and not loaded", async () => {
    installed = [{ name: "retiredfixture", version: "1.0.0", sourceId: "ave", originCommit: null }];
    revocationRegistry.replace([{
      sourceId: "ave", kind: "plugin", name: "retiredfixture", versions: "*", reason: "retired", at: "2026-09-01", action: "uninstall",
    }]);
    const { ctx, send } = context();
    disposers.push(await setupAlerts(ctx));
    expect((await raiseReply(ctx)).status).toBe("raised");
    expect(send).toHaveBeenCalledWith(OVERLAY_V1.show, expect.objectContaining({ source: expect.objectContaining({ kind: "alert" }) }));
    await ctx.alertsService.flush();
  });

  it("keeps blocking while a revoked predecessor is still loaded", async () => {
    installed = [{ name: "retiredfixture", version: "1.0.0", sourceId: "ave", originCommit: null }];
    loaded = ["retiredfixture"];
    revocationRegistry.replace([{
      sourceId: "ave", kind: "plugin", name: "retiredfixture", versions: "*", reason: "retired", at: "2026-09-01", action: "uninstall",
    }]);
    const { ctx } = context();
    disposers.push(await setupAlerts(ctx));
    expect((await raiseReply(ctx)).status).toBe("blocked_by_predecessor");
    await ctx.alertsService.flush();
  });

  it("ignores a same-named package from an unrelated source", async () => {
    installed = [{ name: "retiredfixture", version: "1.0.0", sourceId: "elsewhere", originCommit: null }];
    const { ctx } = context();
    disposers.push(await setupAlerts(ctx));
    expect((await raiseReply(ctx)).status).toBe("raised");
    await ctx.alertsService.flush();
  });

  it("hears an uninstall on the host bus: the plugin's cards go and its choices are kept absent", async () => {
    const { ctx, send } = context();
    disposers.push(await setupAlerts(ctx));
    const { alertId } = (await raiseReply(ctx)) as { alertId: string };
    emitEvent("plugin.uninstalled", { pluginId: "fixturemail" });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(OVERLAY_V1.dismiss, `alert:${alertId}`);
      expect(settings.kinds["fixturemail:reply"]?.absentSinceAppVersion).toBeDefined();
    });
    await ctx.alertsService.flush();
  });
});
