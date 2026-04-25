/**
 * IPC sender validation regression test — fix/ipc-sender-full-audit
 *
 * Two concerns:
 *  1. validateSender() allows trusted frames (file://, localhost) and rejects
 *     untrusted origins.
 *  2. Every channel classified as TIER 1 or TIER 2 in the channel manifest has
 *     a validateSender() guard present in ipc-bridge.ts source text.
 *     TIER 3 (read-only) channels are explicitly excluded from the requirement.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateSender } from "../../src/ipc-bridge.js";
import type { IpcMainInvokeEvent } from "electron";

// ─── Channel manifest ────────────────────────────────────────────────────────

/**
 * TIER 1: destructive or settings/permissions/plugins/files/network mutators.
 * TIER 2: triggers LLM calls or writes memory/tasks.
 * TIER 3: pure read-only queries — guard not required.
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
  "ave:memory:ave-md:get": "tier3",
  "ave:memory:ave-md:update": "tier1",
  "ave:memory:user-prefs:get": "tier3",
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
  // Approval
  "ave:approval:respond": "tier1",
  // Policy
  "ave:policy:get": "tier3",
  "ave:policy:set": "tier1",
  // Tasks
  "ave:tasks:add": "tier1",
  "ave:tasks:update": "tier1",
  "ave:tasks:get": "tier3",
  "ave:tasks:delete": "tier1",
  "ave:tasks:query": "tier3",
  "ave:tasks:pending": "tier3",
  "ave:tasks:overdue": "tier3",
  "ave:tasks:today": "tier3",
  // Routine
  "ave:routine:get-latest-result": "tier3",
  "ave:routines:dev-trigger-wakeup": "tier1",
  "ave:routines:dev-trigger-schedule": "tier1",
  "ave:routines:dev-trigger-shutdown": "tier1",
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
  const bridgePath = join(__dirname, "../../src/ipc-bridge.ts");
  const source = readFileSync(bridgePath, "utf-8");

  const gatedChannels = Object.entries(CHANNEL_MANIFEST)
    .filter(([, tier]) => tier === "tier1" || tier === "tier2")
    .map(([channel]) => channel);

  const tier3Channels = Object.entries(CHANNEL_MANIFEST)
    .filter(([, tier]) => tier === "tier3")
    .map(([channel]) => channel);

  for (const channel of gatedChannels) {
    it(`${channel} has validateSender guard`, () => {
      // Find the ipcMain.handle block for this channel and check that
      // validateSender appears between this channel registration and the next.
      const channelPattern = new RegExp(
        `ipcMain\\.handle\\("${channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      );
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
      const channelPattern = new RegExp(
        `ipcMain\\.handle\\("${channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      );
      const channelIdx = source.search(channelPattern);
      expect(channelIdx, `channel "${channel}" not found in ipc-bridge.ts`).toBeGreaterThan(-1);
    });
  }
});
