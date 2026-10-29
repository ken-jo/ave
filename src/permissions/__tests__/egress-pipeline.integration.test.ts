import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, type ReviewerDispatchResult } from "../permission-manager.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { createEgressAskCallback } from "../egress-ask.js";
import { createApprovalGateEgressRequester, createShellNetworkPermissionEvaluator } from "../egress-approval.js";
import { EgressGrantStore } from "../egress-grants.js";
import type { ShellEgressOwner } from "../egress-invocations.js";
import { sentApprovalCards } from "../../__tests__/test-helpers.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const DESTINATION = { host: "downloads.example.com", port: 443 };
const TOKEN = "1".repeat(32);

function fixture(options: { headless?: boolean; forced?: boolean; askEnabled?: boolean; mode?: "strict" | "default" | "auto" | "allow" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "egress-pipeline-"));
  directories.push(directory);
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode(options.mode ?? "strict");
  const onNoApprover = vi.fn();
  const owner: ShellEgressOwner = { kind: "shell", toolName: "bash", toolUseId: "call-1", context: {
    sessionId: "session-1", workspaceRoot: directory, headless: options.headless,
    approvalSurface: options.headless ? "unavailable" : "interactive", onNoApprover,
    ...(options.forced ? { permissionContext: { floor: { code: "other-principal", reason: "Another principal owns this turn." } } } : {}),
  } };
  const grants = new EgressGrantStore(join(directory, "egress.json"));
  const wc = { send: vi.fn(), isDestroyed: () => false };
  const gate = new ApprovalGate(wc as never, undefined, 5_000, { log: vi.fn() } as never);
  const evaluate = vi.fn(createShellNetworkPermissionEvaluator(manager));
  const requester = createApprovalGateEgressRequester(gate, manager);
  const callback = createEgressAskCallback({
    identityStrength: () => "kernel-channel", ownerOf: (token) => token === TOKEN ? owner : undefined,
    abortSignalOf: () => undefined, workerAllowedDomains: () => [], grants,
    evaluateShellPermission: evaluate, shellAskEnabled: () => options.askEnabled ?? true, requester: () => requester, audit: () => {},
  });
  const subject = { token: TOKEN, sessionId: "session-1", tabId: undefined, projectRoot: directory, origin: "shell" as const };
  const connection = async () => {
    const who = { attributionKey: TOKEN, identity: "listener" as const };
    const named = await callback(DESTINATION, { ...who, phase: "name" });
    return named === true ? callback(DESTINATION, { ...who, phase: "resolved", addresses: ["93.184.216.34"], resolution: "pinned" }) : named;
  };
  const card = async (count: number) => {
    await vi.waitFor(() => expect(sentApprovalCards(wc)).toHaveLength(count));
    return sentApprovalCards<ApprovalRequest>(wc)[count - 1]!;
  };
  const answer = (request: ApprovalRequest, allow: boolean) => gate.resolveFromDesktopRenderer(request.id, {
    requestId: request.id, nonce: request.nonce, hmac: request.hmac, choice: allow ? "allow-once" : "deny-once",
    ...(allow ? { egressScope: "once" as const } : {}),
  }, wc as never);
  return { manager, owner, grants, wc, gate, evaluate, subject, callback, connection, card, answer, onNoApprover };
}

async function remember(f: ReturnType<typeof fixture>) {
  await f.grants.grant("always", ["always"], f.subject, { ...DESTINATION, network: "public" });
}

describe("actual shell network pipeline authority", () => {
  it("a remembered destination cannot bypass an inherited floor in allow mode", async () => {
    const f = fixture({ forced: true, mode: "allow" });
    await remember(f);
    const review = vi.spyOn(f.manager, "dispatchReviewer");
    const pending = f.connection();
    const request = await f.card(1);
    expect(request.egressHost?.scopes).toEqual(["once"]);
    f.answer(request, false);
    await expect(pending).resolves.toMatchObject({ allow: false });
    expect(review).not.toHaveBeenCalled();
    expect(f.onNoApprover).not.toHaveBeenCalled();
  });

  it("a network allow rule cannot bypass an inherited headless floor", async () => {
    const f = fixture({ forced: true, headless: true, mode: "allow" });
    f.manager.setRules([{ pattern: "Network(downloads.example.com:443)", action: "allow" }]);
    await expect(f.connection()).resolves.toEqual({ allow: false, reason: "Nobody can approve this request; do not retry." });
    expect(sentApprovalCards(f.wc)).toEqual([]);
    expect(f.onNoApprover).toHaveBeenCalledOnce();
  });

  it("forced consent continues the same connection once and never creates a standing grant", async () => {
    const f = fixture({ forced: true, mode: "allow" });
    const first = f.connection();
    f.answer(await f.card(1), true);
    await expect(first).resolves.toBe(true);
    expect(f.evaluate).toHaveBeenCalledTimes(2);
    expect(await f.grants.matchingScope(f.subject, { ...DESTINATION, network: "public" }, ["once", "session", "always"])).toBeUndefined();
    const second = f.connection();
    f.answer(await f.card(2), false);
    await expect(second).resolves.toMatchObject({ allow: false });
    expect(sentApprovalCards(f.wc)).toHaveLength(2);
  });

  it("ordinary remembered consent is evaluated before headless human fallback", async () => {
    const f = fixture({ headless: true });
    await remember(f);
    await expect(f.connection()).resolves.toBe(true);
    expect(f.evaluate).toHaveBeenCalledTimes(2);
    expect(f.onNoApprover).not.toHaveBeenCalled();
    expect(sentApprovalCards(f.wc)).toEqual([]);
  });

  it.each(["deny", "ask"] as const)("a network %s rule outranks a remembered grant", async (action) => {
    const f = fixture({ headless: true });
    await remember(f);
    f.manager.setRules([{ pattern: "Network(downloads.example.com:443)", action }]);
    await expect(f.connection()).resolves.toMatchObject({ allow: false });
    expect(f.onNoApprover).toHaveBeenCalledTimes(action === "ask" ? 1 : 0);
    expect(sentApprovalCards(f.wc)).toEqual([]);
  });

  it("allow mode still evaluates every actual connection phase", async () => {
    const f = fixture({ headless: true, mode: "allow" });
    await expect(f.connection()).resolves.toBe(true);
    await expect(f.connection()).resolves.toBe(true);
    expect(f.evaluate).toHaveBeenCalledTimes(4);
    expect(await f.grants.matchingScope(f.subject, { ...DESTINATION, network: "public" }, ["once", "session", "always"])).toBeUndefined();
  });

  it("automatic review does not mint a destination grant for later connections", async () => {
    const f = fixture({ headless: true, mode: "auto" });
    const review = vi.spyOn(f.manager, "dispatchReviewer").mockResolvedValue({ verdict: { level: "low", reason: "Reviewed connection." }, outcome: "host-determined", cacheReason: "miss-not-found", judge: { judged: false, skip: "judge-off" } } satisfies ReviewerDispatchResult);
    await expect(f.connection()).resolves.toBe(true);
    await expect(f.connection()).resolves.toBe(true);
    expect(review).toHaveBeenCalledTimes(2);
    expect(await f.grants.matchingScope(f.subject, { ...DESTINATION, network: "public" }, ["once", "session", "always"])).toBeUndefined();
    expect(f.onNoApprover).not.toHaveBeenCalled();
  });

  it("a resolved private destination changes the automatic review identity", async () => {
    const f = fixture({ headless: true, mode: "auto" });
    const review = vi.spyOn(f.manager, "dispatchReviewer").mockResolvedValue({ verdict: { level: "low", reason: "Reviewed connection." }, outcome: "host-determined", cacheReason: "miss-not-found", judge: { judged: false, skip: "judge-off" } } satisfies ReviewerDispatchResult);
    const who = { attributionKey: TOKEN, identity: "listener" as const };
    await expect(f.callback(DESTINATION, { ...who, phase: "name" })).resolves.toBe(true);
    await expect(f.callback(DESTINATION, { ...who, phase: "resolved", addresses: ["10.0.0.8"], resolution: "pinned" })).resolves.toBe(true);
    expect(review.mock.calls.map(([, input]) => input.finalInput.network)).toEqual(["public", "local"]);
  });
});

describe("network ask availability follows the permission matrix", () => {
  it("allow mode does not require an enabled human card", async () => {
    const f = fixture({ mode: "allow", askEnabled: false });
    await expect(f.connection()).resolves.toBe(true);
    expect(sentApprovalCards(f.wc)).toEqual([]);
    expect(f.onNoApprover).not.toHaveBeenCalled();
  });

  it.each(["low", "medium", "high"] as const)("auto %s reviews before a disabled human-card fallback", async (level) => {
    const f = fixture({ mode: "auto", askEnabled: false });
    const review = vi.spyOn(f.manager, "dispatchReviewer").mockResolvedValue({ verdict: { level, reason: "Reviewed connection." }, outcome: "host-determined", cacheReason: "miss-not-found", judge: { judged: false, skip: "judge-off" } } satisfies ReviewerDispatchResult);
    const result = await f.connection();
    expect(result).toEqual(level === "high" ? { allow: false, reason: "Nobody can approve this request; do not retry." } : true);
    expect(review).toHaveBeenCalledOnce();
    expect(review.mock.calls[0][3]?.lane).toBe("headless");
    expect(sentApprovalCards(f.wc)).toEqual([]);
    expect(f.onNoApprover).toHaveBeenCalledTimes(level === "high" ? 1 : 0);
  });

  it.each(["strict", "default"] as const)("%s denies without retry when a required card is disabled", async (mode) => {
    const f = fixture({ mode, askEnabled: false });
    await expect(f.connection()).resolves.toEqual({ allow: false, reason: "Nobody can approve this request; do not retry." });
    expect(sentApprovalCards(f.wc)).toEqual([]);
    expect(f.onNoApprover).toHaveBeenCalledOnce();
  });

  it.each(["allow", "auto"] as const)("a %s floor never reviews or reuses a grant when cards are disabled", async (mode) => {
    const f = fixture({ mode, forced: true, askEnabled: false });
    await remember(f);
    const review = vi.spyOn(f.manager, "dispatchReviewer");
    await expect(f.connection()).resolves.toEqual({ allow: false, reason: "Nobody can approve this request; do not retry." });
    expect(review).not.toHaveBeenCalled();
    expect(f.onNoApprover).toHaveBeenCalledOnce();
  });
});
