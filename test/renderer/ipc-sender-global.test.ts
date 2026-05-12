/**
 * IPC sender validation regression test — fix/ipc-sender-full-audit
 *
 * Two concerns:
 *  1. validateSender() allows trusted frames (file://, localhost) and rejects
 *     untrusted origins.
 *  2. Every channel classified as TIER 1 or TIER 2 in the channel manifest has
 *     a validateSender() guard present in the IPC domain source files
 *     (src/ipc/domains/*). TIER 3 (read-only) channels are excluded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { OVERLAY_V1, PERMISSIONS, ROUTINES_V2 } from "../../src/shared/ipc-channels.js";
import { validateSender } from "../../src/ipc/gated.js";
import type { IpcMainInvokeEvent } from "electron";

// ─── Channel manifest ────────────────────────────────────────────────────────

/**
 * TIER 1: destructive or settings/permissions/plugins/files/network mutators.
 * TIER 2: triggers LLM calls, writes memory/tasks, or reads sensitive local context.
 * TIER 3: pure non-sensitive read-only queries — guard not required.
 */
const CHANNEL_MANIFEST: Record<string, "tier1" | "tier2" | "tier3"> = {
  // Settings
  "ave:settings:get": "tier3",
  "ave:settings:update": "tier1",
  "ave:settings:set-api-key": "tier1",
  "ave:settings:has-api-key": "tier3",
  "ave:settings:delete-api-key": "tier1",
  "ave:settings:set-web-api-key": "tier1",
  "ave:settings:has-web-api-key": "tier3",
  "ave:settings:delete-web-api-key": "tier1",
  // Chat
  "ave:chat:has-provider": "tier3",
  "ave:chat:send": "tier2",
  "ave:chat:new": "tier1",
  "ave:chat:sessions": "tier3",
  "ave:chat:load-session": "tier1",
  "ave:chat:get-history": "tier3",
  "ave:chat:edit-resend": "tier2",
  "ave:chat:fork": "tier2",
  "ave:chat:retry-effort": "tier2",
  "ave:chat:export": "tier2",
  // Memory
  "ave:memory:entries:list": "tier2",
  "ave:memory:entries:save": "tier2",
  "ave:memory:entries:delete": "tier1",
  "ave:memory:entries:search": "tier2",
  "ave:memory:index:get": "tier2",
  "ave:memory:sessions:list": "tier2",
  "ave:memory:sessions:search": "tier2",
  "ave:memory:agents-md:get": "tier2",
  "ave:memory:agents-md:update": "tier1",
  "ave:memory:ave-md:get": "tier2",
  "ave:memory:ave-md:update": "tier1",
  "ave:memory:user-prefs:get": "tier2",
  "ave:memory:user-prefs:update": "tier1",
  // Plugins
  "ave:plugins:marketplace:list": "tier3",
  "ave:plugins:install": "tier1",
  "ave:plugins:uninstall": "tier1",
  "ave:plugins:ui:list": "tier3",
  "ave:plugins:cards": "tier3",
  "ave:plugins:perf-stats": "tier3",
  "ave:plugins:call": "tier2",
  // MCP
  "ave:mcp:servers": "tier3",
  "ave:mcp:kill": "tier1",
  // Permissions
  "ave:permission:get-mode": "tier3",
  "ave:permission:set-mode": "tier1",
  "ave:permission:list-rules": "tier3",
  "ave:permission:add-rule": "tier1",
  "ave:permission:remove-rule": "tier1",
  [PERMISSIONS.dirDispatch]: "tier1",
  [PERMISSIONS.reviewerDispatch]: "tier2",
  [PERMISSIONS.deferredList]: "tier2",
  [PERMISSIONS.deferredResolve]: "tier1",
  [PERMISSIONS.auditShow]: "tier2",
  [PERMISSIONS.auditVerify]: "tier2",
  [PERMISSIONS.hookTrustList]: "tier2",
  // Approval
  "ave:approval:respond": "tier1",
  // Policy
  "ave:policy:get": "tier3",
  "ave:policy:set": "tier1",
  // Usage / observability
  "ave:usage:summary": "tier3",
  // Conversation UX extras
  "ave:starred:list": "tier3",
  "ave:starred:add": "tier2",
  "ave:starred:remove": "tier2",
  // Audit
  "ave:audit:search": "tier3",
  "ave:audit:stats": "tier3",
  // Telemetry
  "ave:telemetry:consent-answer": "tier1",
  // Routines v2 — invoke channels only (fired/running-started/running-finished are main→renderer push, no handle)
  "ave:routines:v2:list": "tier3",
  "ave:routines:v2:add": "tier1",
  "ave:routines:v2:dismiss": "tier1",
  "ave:routines:v2:remove": "tier1",
  "ave:routines:v2:trigger-now": "tier1",
  "ave:routines:v2:list-sessions": "tier3",
  "ave:routines:v2:read-session": "tier2",
  // Overlay v1 — primary-action is renderer→main invoke (write influence); show/update/dismiss are main→renderer push events
  "ave:overlay:primary-action": "tier1",
};

// ─── validateSender unit tests ───────────────────────────────────────────────

function makeEvent(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url } } as unknown as IpcMainInvokeEvent;
}

describe("validateSender", () => {
  it("trusts file:// renderer (packaged app)", () => {
    expect(validateSender(makeEvent("file:///app/index.html"))).toBe(true);
  });

  it("trusts http://localhost dev server", () => {
    expect(validateSender(makeEvent("http://localhost:5173/"))).toBe(true);
  });

  it("trusts http://127.0.0.1 dev server", () => {
    expect(validateSender(makeEvent("http://127.0.0.1:5173/"))).toBe(true);
  });

  it("rejects https://evil.com (remote origin)", () => {
    expect(validateSender(makeEvent("https://evil.com"))).toBe(false);
  });

  it("rejects http://localhost.attacker.com (hostname spoof)", () => {
    expect(validateSender(makeEvent("http://localhost.attacker.com"))).toBe(false);
  });

  it("rejects https://localhost (HTTPS is not trusted)", () => {
    expect(validateSender(makeEvent("https://localhost"))).toBe(false);
  });

  it("rejects empty url", () => {
    expect(validateSender(makeEvent(""))).toBe(false);
  });

  it("returns true when event has no senderFrame (test synthetic events)", () => {
    expect(validateSender(null)).toBe(true);
    expect(validateSender(undefined)).toBe(true);
    expect(validateSender({} as IpcMainInvokeEvent)).toBe(true);
  });
});

// ─── Source-level guard audit ────────────────────────────────────────────────

describe("ipc-bridge.ts — TIER 1/2 channels have validateSender guard", () => {
  // ipc-bridge.ts is now a thin re-export shim; all handler source lives in
  // src/ipc/domains/*. Aggregate the full source so the channel + guard checks
  // remain valid against the actual implementation files.
  const domainDir = join(__dirname, "../../src/ipc/domains");
  const domainFiles = ["settings.ts", "chat.ts", "plugins.ts", "usage.ts", "audit.ts", "permissions.ts", "window.ts", "misc.ts"];
  // Inline IPC channel SoT constants (`shared/ipc-channels.ts`) into the
  // aggregated source so handlers written as `ipcMain.handle(ROUTINES_V2.list,
  // ...)` are matched by the same `ipcMain.handle("ave:routines:v2:list"`
  // pattern the test runs for the other channels. Without this, Routine v2 +
  // Overlay V1 channels read as "not found in source" even though their
  // handlers live in `misc.ts`.
  const constInlinePairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(ROUTINES_V2)) {
    constInlinePairs.push([`ROUTINES_V2.${key}`, `"${value}"`]);
  }
  for (const [key, value] of Object.entries(OVERLAY_V1)) {
    constInlinePairs.push([`OVERLAY_V1.${key}`, `"${value}"`]);
  }
  // Substitute longer reference strings first so prefix collisions don't
  // corrupt later replacements (e.g. `ROUTINES_V2.list` would otherwise
  // partially rewrite `ROUTINES_V2.listSessions`).
  constInlinePairs.sort((a, b) => b[0].length - a[0].length);
  const rawSource = domainFiles
    .map((f) => readFileSync(join(domainDir, f), "utf-8"))
    .join("\n");
  let source = rawSource;
  for (const [ref, literal] of constInlinePairs) {
    source = source.split(ref).join(literal);
  }

  const gatedChannels = Object.entries(CHANNEL_MANIFEST)
    .filter(([, tier]) => tier === "tier1" || tier === "tier2")
    .map(([channel]) => channel);

  const tier3Channels = Object.entries(CHANNEL_MANIFEST)
    .filter(([, tier]) => tier === "tier3")
    .map(([channel]) => channel);
  const channelConstantAliases: Record<string, string> = {
    "ave:routines:v2:list": "ROUTINES_V2.list",
    "ave:routines:v2:add": "ROUTINES_V2.add",
    "ave:routines:v2:dismiss": "ROUTINES_V2.dismiss",
    "ave:routines:v2:remove": "ROUTINES_V2.remove",
    "ave:routines:v2:trigger-now": "ROUTINES_V2.triggerNow",
    "ave:routines:v2:list-sessions": "ROUTINES_V2.listSessions",
    "ave:routines:v2:read-session": "ROUTINES_V2.readSession",
    "ave:overlay:primary-action": "OVERLAY_V1.primaryAction",
    "ave:permission:get-mode": "PERMISSIONS.getMode",
    "ave:permission:set-mode": "PERMISSIONS.setMode",
    "ave:permission:list-rules": "PERMISSIONS.listRules",
    "ave:permission:add-rule": "PERMISSIONS.addRule",
    "ave:permission:remove-rule": "PERMISSIONS.removeRule",
    "ave:approval:respond": "PERMISSIONS.approvalRespond",
    "ave:policy:get": "PERMISSIONS.policyGet",
    "ave:policy:set": "PERMISSIONS.policySet",
    [PERMISSIONS.dirDispatch]: "PERMISSIONS.dirDispatch",
    [PERMISSIONS.reviewerDispatch]: "PERMISSIONS.reviewerDispatch",
    [PERMISSIONS.deferredList]: "PERMISSIONS.deferredList",
    [PERMISSIONS.deferredResolve]: "PERMISSIONS.deferredResolve",
    [PERMISSIONS.auditShow]: "PERMISSIONS.auditShow",
    [PERMISSIONS.auditVerify]: "PERMISSIONS.auditVerify",
    [PERMISSIONS.hookTrustList]: "PERMISSIONS.hookTrustList",
  };
  const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const handlePatternFor = (channel: string): RegExp => {
    const literal = `"${escapeRegex(channel)}"`;
    const alias = channelConstantAliases[channel];
    const target = alias ? `(?:${literal}|${escapeRegex(alias)})` : literal;
    return new RegExp(`ipcMain\\.handle\\(\\s*${target}\\s*,`);
  };

  for (const channel of gatedChannels) {
    it(`${channel} has validateSender guard`, () => {
      // Find the ipcMain.handle block for this channel and check that
      // validateSender appears between this channel registration and the next.
      const channelPattern = handlePatternFor(channel);
      const channelIdx = source.search(channelPattern);
      expect(channelIdx, `channel "${channel}" not found in ipc-bridge.ts`).toBeGreaterThan(-1);

      // Grab the source from channel declaration to the next ipcMain.handle or end of registerIpcHandlers
      const afterChannel = source.slice(channelIdx);
      const nextHandleIdx = afterChannel.search(/ipcMain\.handle\((?!.*"ave:)/);
      const nextHandleRealIdx = afterChannel.indexOf("ipcMain.handle(", 10); // skip self
      const snippet = nextHandleRealIdx > 0
        ? afterChannel.slice(0, nextHandleRealIdx)
        : afterChannel.slice(0, 1000);

      expect(
        snippet,
        `channel "${channel}" (${CHANNEL_MANIFEST[channel]}) is missing validateSender guard`,
      ).toContain("validateSender(");
    });
  }

  for (const channel of tier3Channels) {
    it(`${channel} is classified read-only (TIER 3)`, () => {
      const channelPattern = handlePatternFor(channel);
      const channelIdx = source.search(channelPattern);
      expect(channelIdx, `channel "${channel}" not found in ipc-bridge.ts`).toBeGreaterThan(-1);
    });
  }
});
