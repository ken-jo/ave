import { PermissionManager } from "../../../permissions/permission-manager.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { foreignFrameEvent, hostFrameEvent, sentApprovalCards } from "../../../__tests__/test-helpers.js";
import { ApprovalGate, type ApprovalRequest } from "../../../permissions/approval-gate.js";
import { createEgressAskRuntimeCallback } from "../../../permissions/egress-runtime.js";
import { openEgressInvocation } from "../../../permissions/egress-invocations.js";
import { setProcessPlatform } from "../../../__tests__/support/process-platform.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) } }));

const { registerPermissionsHandlers } = await import("../permissions.js");
const originalPlatform = process.platform;
afterEach(() => { vi.unstubAllEnvs(); setProcessPlatform(originalPlatform); });

describe("domain grant management boundary", () => {
  it("lists a dock-approved Always grant, revokes it through the guarded handler, and asks again", async () => {
    const home = mkdtempSync(join(tmpdir(), "ave-domain-ipc-"));
    vi.stubEnv("AVE_HOME", home);
    setProcessPlatform("linux");
    const wc = { send: vi.fn(), isDestroyed: () => false };
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(wc as never, undefined, 5_000, auditLogger as never);
    const permissionManager = new PermissionManager(join(home, "permissions.json"));
    permissionManager.setMode("strict");
    registerPermissionsHandlers({ conversationLoop: { permissionManager }, approvalGate: gate, auditLogger, settingsService: { get: () => undefined } } as never);
    const ask = createEgressAskRuntimeCallback({ approvalGate: gate, permissionManager, shellAskEnabled: () => true });
    const owner = { kind: "shell" as const, toolName: "bash" as const, toolUseId: undefined, context: { sessionId: "domain-session", workspaceRoot: home, approvalSurface: "interactive" as const } };
    const first = openEgressInvocation(owner);
    const second = openEgressInvocation(owner);
    const destination = { host: "downloads.example.com", port: 443 };
    const call = (channel: string, payload?: unknown, event = hostFrameEvent()) => handlers.get(channel)!(event, payload);
    try {
      const pending = ask(destination, { attributionKey: first.token, identity: "listener", phase: "name" });
      await vi.waitFor(() => expect(sentApprovalCards(wc)).toHaveLength(1));
      const card = sentApprovalCards<ApprovalRequest>(wc)[0]!;
      gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", egressScope: "always", nonce: card.nonce, hmac: card.hmac }, wc as never);
      expect(await pending).toBe(true);
      expect(await ask(destination, { attributionKey: first.token, identity: "listener", phase: "resolved", addresses: ["93.184.215.14"], resolution: "pinned" })).toBe(true);
      const target = { scope: "always", origin: "shell", ...destination, network: "public" };
      expect(await call(PERMISSIONS.egressGrantsList)).toEqual({ ok: true, grants: [expect.objectContaining(target)] });
      expect(await call(PERMISSIONS.egressGrantsList, undefined, foreignFrameEvent("file:///dist/src/plugin-ui-shell.html"))).toMatchObject({ error: "unauthorized-frame" });
      expect(await call(PERMISSIONS.egressGrantRevoke, target)).toMatchObject({ error: "user-keyboard-required" });
      const intent = { inputOrigin: "user-keyboard", userActivation: true };
      expect(await call(PERMISSIONS.egressGrantRevoke, { ...target, intent }, foreignFrameEvent("file:///dist/src/plugin-ui-shell.html"))).toMatchObject({ error: "unauthorized-frame" });
      for (const override of [{ host: "Downloads.example.com" }, { port: 0 }, { port: 65536 }, { network: "reserved" }, { scope: "once" }, { origin: "worker" }]) {
        expect(await call(PERMISSIONS.egressGrantRevoke, { ...target, ...override, intent })).toMatchObject({ ok: false });
      }
      expect(await call(PERMISSIONS.egressGrantRevoke, { ...target, intent: { inputOrigin: "user-keyboard", userActivation: true } })).toEqual({ ok: true });
      expect(await call(PERMISSIONS.egressGrantsList)).toEqual({ ok: true, grants: [] });
      const afterRevoke = ask(destination, { attributionKey: second.token, identity: "listener", phase: "name" });
      await vi.waitFor(() => expect(sentApprovalCards(wc)).toHaveLength(2));
      const next = sentApprovalCards<ApprovalRequest>(wc)[1]!;
      gate.resolveFromDesktopRenderer(next.id, { requestId: next.id, choice: "deny-once", nonce: next.nonce, hmac: next.hmac }, wc as never);
      expect(await afterRevoke).toEqual({ allow: false, reason: "denied by the user" });
      expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ output: expect.stringContaining("[egress-grant:revoke]") }));
    } finally {
      first.release(); second.release();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
