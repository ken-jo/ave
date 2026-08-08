/**
 * IPC sender validation regression test — fix/ipc-sender-full-audit
 *
 * Two concerns:
 *  1. validateSender() allows trusted frames (file://, localhost) and rejects
 *     untrusted origins.
 *  2. Every channel classified as mutating or sensitive in the channel manifest has
 *     a sender guard present in the IPC domain source files
 *     (src/ipc/domains/*). Public read-only channels are excluded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { OVERLAY_V1, PERMISSIONS, ROUTINES_V2 } from "../../src/shared/ipc-channels.js";
import { CHANNELS } from "../../src/contract/app-contract.js";
import { validateSender } from "../../src/ipc/gated.js";
import type { IpcMainInvokeEvent } from "electron";

// ─── Channel manifest ────────────────────────────────────────────────────────

/**
 * mutating: destructive or settings/permissions/plugins/files/network mutators.
 * sensitive: triggers LLM calls, writes memory/tasks, or reads sensitive local context.
 * public read-only: pure non-sensitive read-only queries — guard not required.
 */
const CHANNEL_MANIFEST: Record<string, "mutating" | "sensitive" | "public-read"> = {
  // Settings
  "ave:settings:get": "public-read",
  "ave:settings:update": "mutating",
  "ave:settings:set-api-key": "mutating",
  "ave:settings:has-api-key": "public-read",
  "ave:settings:delete-api-key": "mutating",
  "ave:settings:set-web-api-key": "mutating",
  "ave:settings:has-web-api-key": "public-read",
  "ave:settings:delete-web-api-key": "mutating",
  // Chat
  "ave:chat:has-provider": "public-read",
  "ave:chat:send": "sensitive",
  "ave:chat:new": "mutating",
  "ave:chat:sessions": "public-read",
  "ave:chat:get-history": "public-read",
  "ave:chat:edit-resend": "sensitive",
  "ave:chat:fork": "sensitive",
  "ave:chat:continue-last-user": "sensitive",
  "ave:chat:retry-effort": "sensitive",
  "ave:chat:export": "sensitive",
  // Memory
  "ave:memory:entries:list": "sensitive",
  "ave:memory:entries:save": "sensitive",
  "ave:memory:entries:delete": "mutating",
  "ave:memory:candidates:list": "sensitive",
  "ave:memory:candidates:activate": "mutating",
  "ave:memory:candidates:delete": "mutating",
  "ave:memory:entries:search": "sensitive",
  "ave:memory:index:get": "sensitive",
  "ave:memory:long-term:refresh": "sensitive",
  "ave:memory:sessions:list": "sensitive",
  "ave:memory:sessions:search": "sensitive",
  "ave:memory:agents-md:get": "sensitive",
  "ave:memory:agents-md:update": "mutating",
  "ave:memory:user-prefs:get": "sensitive",
  "ave:memory:user-prefs:update": "mutating",
  // Plugins
  "ave:plugins:marketplace:list": "public-read",
  "ave:plugins:install": "mutating",
  "ave:plugins:uninstall": "mutating",
  "ave:plugins:ui:list": "public-read",
  "ave:plugins:cards": "public-read",
  "ave:plugins:perf-stats": "public-read",
  "ave:plugins:call": "sensitive",
  // MCP
  "ave:mcp:servers": "public-read",
  "ave:mcp:kill": "mutating",
  // Permissions
  "ave:permission:get-mode": "public-read",
  "ave:permission:set-mode": "mutating",
  "ave:permission:list-rules": "public-read",
  "ave:permission:add-rule": "mutating",
  "ave:permission:remove-rule": "mutating",
  [PERMISSIONS.dirDispatch]: "mutating",
  [PERMISSIONS.reviewerDispatch]: "sensitive",
  [PERMISSIONS.deferredList]: "sensitive",
  [PERMISSIONS.deferredResolve]: "mutating",
  [PERMISSIONS.auditShow]: "sensitive",
  [PERMISSIONS.auditVerify]: "sensitive",
  [PERMISSIONS.hookTrustList]: "sensitive",
  // Approval
  "ave:approval:respond": "mutating",
  "ave:permissions:approval-sentence-select": "mutating",
  // Policy
  "ave:policy:get": "public-read",
  "ave:policy:set": "mutating",
  // Usage / observability
  "ave:usage:summary": "public-read",
  // Conversation UX extras
  "ave:starred:list": "public-read",
  "ave:starred:add": "sensitive",
  "ave:starred:remove": "sensitive",
  // Audit
  "ave:audit:search": "public-read",
  "ave:audit:stats": "public-read",
  // Telemetry
  "ave:telemetry:consent-answer": "mutating",
  // Routines v2 — invoke channels only (fired/running-started/running-finished are main→renderer push, no handle)
  "ave:routines:v2:list": "public-read",
  "ave:routines:v2:add": "mutating",
  "ave:routines:v2:dismiss": "mutating",
  "ave:routines:v2:remove": "mutating",
  "ave:routines:v2:trigger-now": "mutating",
  "ave:routines:v2:list-sessions": "public-read",
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

describe("ipc-bridge.ts — mutating/sensitive channels have a sender guard", () => {
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
  // Handlers swept onto the contract SOT read as `ipcMain.handle(CHANNELS.<group>.<key>, …)`
  // (see C2/C11 literal sweep). Recursively inline every CHANNELS.* leaf → its literal so
  // those registrations are matched by the same `ipcMain.handle("ave:…"` scan. Robust to
  // future sweeps: any new CHANNELS reference is picked up automatically.
  const walkChannels = (obj: unknown, path: string): void => {
    if (!obj || typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const nextPath = `${path}.${key}`;
      if (typeof value === "string") {
        constInlinePairs.push([nextPath, `"${value}"`]);
      } else {
        walkChannels(value, nextPath);
      }
    }
  };
  walkChannels(CHANNELS, "CHANNELS");
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
    .filter(([, access]) => access === "mutating" || access === "sensitive")
    .map(([channel]) => channel);

  const publicReadChannels = Object.entries(CHANNEL_MANIFEST)
    .filter(([, access]) => access === "public-read")
    .map(([channel]) => channel);
  const channelConstantAliases: Record<string, string> = {
    "ave:routines:v2:list": "ROUTINES_V2.list",
    "ave:routines:v2:add": "ROUTINES_V2.add",
    "ave:routines:v2:dismiss": "ROUTINES_V2.dismiss",
    "ave:routines:v2:remove": "ROUTINES_V2.remove",
    "ave:routines:v2:trigger-now": "ROUTINES_V2.triggerNow",
    "ave:routines:v2:list-sessions": "ROUTINES_V2.listSessions",
    "ave:permission:get-mode": "PERMISSIONS.getMode",
    "ave:permission:set-mode": "PERMISSIONS.setMode",
    "ave:permission:list-rules": "PERMISSIONS.listRules",
    "ave:permission:add-rule": "PERMISSIONS.addRule",
    "ave:permission:remove-rule": "PERMISSIONS.removeRule",
    "ave:approval:respond": "PERMISSIONS.approvalRespond",
    "ave:permissions:approval-sentence-select": "PERMISSIONS.approvalSentenceSelect",
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
    it(`${channel} has sender guard`, () => {
      // Find the ipcMain.handle block for this channel and check that
      // a trusted-frame sender guard appears between this channel registration
      // and the next.
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
        `channel "${channel}" (${CHANNEL_MANIFEST[channel]}) is missing sender guard`,
      ).toMatch(/\bvalidate(?:HostRenderer)?Sender\(/);
    });
  }

  for (const channel of publicReadChannels) {
    it(`${channel} is classified read-only (public read-only)`, () => {
      const channelPattern = handlePatternFor(channel);
      const channelIdx = source.search(channelPattern);
      expect(channelIdx, `channel "${channel}" not found in ipc-bridge.ts`).toBeGreaterThan(-1);
    });
  }
});
