/** Read-only approval, audit, and hook-trust channels are reconnaissance-sensitive.
 * Invoke real handlers with plugin-shell senders to ensure host-only validation rejects them. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { foreignFrameEvent } from "../../__tests__/test-helpers.js";

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handleMap.set(channel, fn);
    }),
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
}));

const { registerPermissionsHandlers } = await import("../domains/permissions.js");
const { PERMISSIONS } = await import("../../shared/ipc-channels.js");

const PLUGIN_SHELL = "file:///dist/src/plugin-ui-shell.html";
const HOST_RENDERER = "file:///dist/src/index.html";

/** Read-only, and each discloses something a plugin can act on. `args` are the minimum a handler
 * needs to reach its guard; the guard runs first, so these never have to be valid beyond that. */
const SENSITIVE_READ_CHANNELS: ReadonlyArray<readonly [string, string, unknown[]]> = [
  ["recentlyDeniedList", PERMISSIONS.recentlyDeniedList, []],
  ["userApprovalList", PERMISSIONS.userApprovalList, []],
  ["listScopedRules", PERMISSIONS.listScopedRules, []],
  ["egressGrantsList", PERMISSIONS.egressGrantsList, []],
  ["auditShow", PERMISSIONS.auditShow, [10]],
  ["auditVerify", PERMISSIONS.auditVerify, []],
  ["hookTrustList", PERMISSIONS.hookTrustList, []],
  ["egressDenialsRecent", PERMISSIONS.egressDenialsRecent, []],
];

beforeEach(() => {
  handleMap.clear();
  // Enough of each dependency for a handler to run to completion once its guard has passed. The guard runs first, so the refusal cases never
  // reach any of this; it exists so the host-renderer cases can prove they got PAST the guard rather than merely not saying "unauthorized-frame".
  const auditLogger = {
    log: vi.fn(),
    logWarn: vi.fn(),
    flush: vi.fn(async () => undefined),
    getAuditDir: vi.fn(() => "/nonexistent-audit-dir"),
    getPermissionAuditSecret: vi.fn(() => null),
  };
  registerPermissionsHandlers({
    conversationLoop: { permissionManager: undefined },
    approvalGate: undefined,
    auditLogger,
    settingsService: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      getSecret: vi.fn(() => null),
    },
  } as never);
});

describe("sensitive read-only permission channels", () => {
  it.each(SENSITIVE_READ_CHANNELS)(
    "%s refuses a plugin shell frame",
    async (_name, channel, args) => {
      const handler = handleMap.get(channel);
      expect(handler, `${channel} was never registered`).toBeDefined();
      const result = await handler!(foreignFrameEvent(PLUGIN_SHELL), ...args);
      expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    },
  );

  it.each(SENSITIVE_READ_CHANNELS)(
    "%s does not refuse the host renderer",
    async (_name, channel, args) => {
      // The guard must reject the shell WITHOUT rejecting the surface that legitimately uses it; a
      // test that only pinned the refusal would pass just as well if the channel refused everyone.
      const handler = handleMap.get(channel);
      const result = await handler!(foreignFrameEvent(HOST_RENDERER), ...args);
      expect(result).not.toMatchObject({ error: "unauthorized-frame" });
    },
  );
});
