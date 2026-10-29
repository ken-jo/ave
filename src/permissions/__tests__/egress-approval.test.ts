// The egress ask on the approval dock: the `egress-host` request shape the gate accepts, the answers it honours (desktop window, allow-once, a scope the card offered) and how the requester maps them back (egress-approval.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, type ReviewerDispatchResult } from "../permission-manager.js";

import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput } from "../approval-gate.js";
import { createApprovalGateEgressRequester as createRequester, EGRESS_APPROVAL_DENY_REASONS } from "../egress-approval.js";
import type { EgressShellApprovalRequest, EgressTerminalApprovalRequest } from "../egress-ask.js";
import { sentApprovalCards } from "../../__tests__/test-helpers.js";

let permissionManager: PermissionManager;
beforeEach(() => {
  permissionManager = new PermissionManager(join(tmpdir(), `egress-policy-${randomUUID()}.json`));
  permissionManager.setMode("strict");
});
function createApprovalGateEgressRequester(gate: Pick<ApprovalGate, "requestAndWait">) {
  return createRequester(gate, permissionManager);
}

function makeWebContents() {

  return { send: vi.fn(), isDestroyed: vi.fn(() => false) };
}

function makeGate() {
  const wc = makeWebContents();
  const auditLogger = { log: vi.fn() };
  const gate = new ApprovalGate(wc as never, undefined, 5_000, auditLogger as never);
  return { wc, gate, auditLogger };
}

const egressRequest = (overrides: Partial<EgressShellApprovalRequest> = {}): EgressShellApprovalRequest => ({
  origin: "shell",
  sessionId: "session-1",
  toolName: "bash",
  toolUseId: "toolu_1",
  destination: { host: "github.com", port: 443 },
  scopes: ["once", "session", "project", "always"],
  network: "public",
  abortSignal: undefined,
  ...overrides,
});

const TAB = "terminal:0a1b2c3d-1";

const terminalRequest = (overrides: Partial<EgressTerminalApprovalRequest> = {}): EgressTerminalApprovalRequest => ({
  origin: "terminal",
  tabId: TAB,
  destination: { host: "github.com", port: 443 },
  scopes: ["once", "tab", "always"],
  network: "public",
  abortSignal: undefined,
  ...overrides,
});

function lastCard(wc: ReturnType<typeof makeWebContents>): ApprovalRequest {
  const cards = sentApprovalCards<ApprovalRequest>(wc);
  const card = cards.at(-1);
  if (card === undefined) throw new Error("no approval card was sent");
  return card;
}

async function cardSent(wc: ReturnType<typeof makeWebContents>): Promise<ApprovalRequest> {
  await vi.waitFor(() => expect(sentApprovalCards(wc).length).toBeGreaterThan(0));
  return lastCard(wc);
}

describe("egress-host approval requests", () => {
  it("sends the card with the destination and the offered scopes, as the gate's egress-host card", async () => {
    const { wc, gate } = makeGate();
    const answer = createApprovalGateEgressRequester(gate)(egressRequest());
    const card = await cardSent(wc);
    expect(card).toMatchObject({
      kind: "egress-host",
      category: "tool",
      toolName: "bash",
      args: { host: "github.com", port: 443 },
      allowedChoices: ["allow-once", "deny-once"],
      egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", scopes: ["once", "session", "project", "always"], network: "public" },
      sessionId: "session-1",
    });
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", egressScope: "project", nonce: card.nonce, hmac: card.hmac,
    }, wc as never);
    await expect(answer).resolves.toEqual({ allow: true, scope: "project" });
  });

  // Owner 2026-10-25: the card names the host rule "Always deny" stores, and where a project rule would be saved.
  it("carries the exact host rule and, when This project is offered, the project directory", async () => {
    const { wc, gate } = makeGate();
    void createApprovalGateEgressRequester(gate)(egressRequest({ workspaceRoot: "/srv/project" }));
    expect((await cardSent(wc)).egressHost).toMatchObject({ rule: "Network(github.com:443)", projectCwd: "/srv/project" });
    const local = makeGate();
    void createApprovalGateEgressRequester(local.gate)(egressRequest({ destination: { host: "127.0.0.1", port: 8080 }, scopes: ["once", "session"], network: "local", workspaceRoot: "/srv/project" }));
    const card = await cardSent(local.wc);
    expect(card.egressHost?.rule).toBeNull();
    expect(card.egressHost).not.toHaveProperty("projectCwd");
  });

  it("denies when the person denies", async () => {
    const { wc, gate } = makeGate();
    const answer = createApprovalGateEgressRequester(gate)(egressRequest());
    const card = await cardSent(wc);
    gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac }, wc as never);
    await expect(answer).resolves.toEqual({ allow: false, reason: EGRESS_APPROVAL_DENY_REASONS.denied });
  });

  it("ignores an allow from outside the desktop window and keeps the card pending for the desktop", async () => {
    const { wc, gate, auditLogger } = makeGate();
    const answer = createApprovalGateEgressRequester(gate)(egressRequest());
    const card = await cardSent(wc);
    let settled = false;
    void answer.then(() => { settled = true; });
    expect(gate.resolve(card.id, {
      requestId: card.id, choice: "allow-once", egressScope: "always", nonce: card.nonce, hmac: card.hmac,
    })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    const rows = auditLogger.log.mock.calls.map(([row]) => String((row as { output?: string }).output ?? ""));
    expect(rows.some((row) => row.startsWith(`[approval:native-desktop-required] ${card.id}`))).toBe(true);
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", egressScope: "once", nonce: card.nonce, hmac: card.hmac,
    }, wc as never);
    await expect(answer).resolves.toEqual({ allow: true, scope: "once" });
  });

  it("ignores a deny from outside the desktop window too: only the desktop answers an egress ask", async () => {
    const { wc, gate, auditLogger } = makeGate();
    const answer = createApprovalGateEgressRequester(gate)(egressRequest());
    const card = await cardSent(wc);
    let settled = false;
    void answer.then(() => { settled = true; });
    expect(gate.resolve(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    const rows = auditLogger.log.mock.calls.map(([row]) => String((row as { output?: string }).output ?? ""));
    expect(rows.some((row) => row.startsWith(`[approval:native-desktop-required] ${card.id}`))).toBe(true);
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", egressScope: "session", nonce: card.nonce, hmac: card.hmac,
    }, wc as never);
    await expect(answer).resolves.toEqual({ allow: true, scope: "session" });
  });

  it("refuses an allow with a scope the card did not offer, or without one", async () => {
    for (const scope of ["always", undefined] as const) {
      const { wc, gate, auditLogger } = makeGate();
      const answer = createApprovalGateEgressRequester(gate)(egressRequest({ scopes: ["once", "session"] }));
      const card = await cardSent(wc);
      const decision = {
        requestId: card.id,
        choice: "allow-once" as const,
        ...(scope === undefined ? {} : { egressScope: scope }),
        nonce: card.nonce,
        hmac: card.hmac,
      };
      gate.resolveFromDesktopRenderer(card.id, decision, wc as never);
      await expect(answer).resolves.toEqual({ allow: false, reason: EGRESS_APPROVAL_DENY_REASONS.rejected });
      const rows = auditLogger.log.mock.calls.map(([row]) => String((row as { output?: string }).output ?? ""));
      expect(rows.some((row) => row.startsWith(`[approval:egress-scope-rejected] ${card.id}`))).toBe(true);
    }
  });

  it("refuses allow-session even with an offered scope", async () => {
    const { wc, gate } = makeGate();
    const answer = createApprovalGateEgressRequester(gate)(egressRequest());
    const card = await cardSent(wc);
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-session", egressScope: "session", nonce: card.nonce, hmac: card.hmac,
    }, wc as never);
    await expect(answer).resolves.toMatchObject({ allow: false });
  });

  it("ends the ask when the call is aborted", async () => {
    const { wc, gate } = makeGate();
    const controller = new AbortController();
    const answer = createApprovalGateEgressRequester(gate)(egressRequest({ abortSignal: controller.signal }));
    await cardSent(wc);
    controller.abort();
    await expect(answer).resolves.toMatchObject({ allow: false });
  });

  it("rejects a malformed egress-host request outright", async () => {
    const { gate } = makeGate();
    const base: ApprovalRequestInput = {
      id: "egress-bad",
      category: "tool",
      kind: "egress-host",
      toolName: "bash",
      args: { host: "github.com", port: 443 },
      reason: "test",
      createdAt: Date.now(),
      allowedChoices: ["allow-once", "deny-once"],
      durableApprovalRecordAllowed: false,
      forceExplicit: true,
      isReadOnly: false,
      egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", scopes: ["once"], network: "public" },
    };
    await expect(gate.requestAndWait({ ...base, egressHost: undefined })).rejects.toThrow(/needs egressHost/u);
    await expect(gate.requestAndWait({ ...base, egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", scopes: [], network: "public" } }))
      .rejects.toThrow(/needs egressHost/u);
    await expect(gate.requestAndWait({ ...base, egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", scopes: ["once"], network: "lan" as never } }))
      .rejects.toThrow(/names its network/u);
    await expect(gate.requestAndWait({
      ...base, egressHost: { host: "127.0.0.1", port: 8080, rule: null, scopes: ["once", "project"], network: "local" },
    })).rejects.toThrow(/never offered a persistent scope/u);
    await expect(gate.requestAndWait({
      ...base, egressHost: { host: "intranet.corp.test", port: 443, rule: "Network(intranet.corp.test:443)", scopes: ["once", "always"], network: "unverified" },
    })).rejects.toThrow(/never offered a persistent scope/u);
    await expect(gate.requestAndWait({ ...base, allowedChoices: ["allow-once", "allow-always", "deny-once"] }))
      .rejects.toThrow(/exactly allow-once and deny-once/u);
    await expect(gate.requestAndWait({ ...base, durableApprovalRecordAllowed: true }))
      .rejects.toThrow(/never recorded/u);
    await expect(gate.requestAndWait({ ...base, kind: undefined }))
      .rejects.toThrow(/only valid on an egress-host request/u);
    // This tab belongs to a terminal's ask, This session to a shell call's.
    await expect(gate.requestAndWait({ ...base, egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", scopes: ["once", "tab"], network: "public" } }))
      .rejects.toThrow(/only a terminal tab's egress ask offers This tab/u);
    await expect(gate.requestAndWait({
      ...base, egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", scopes: ["once", "session"], network: "public", terminalTabId: TAB },
    })).rejects.toThrow(/offered This tab, not This session/u);
    await expect(gate.requestAndWait({
      ...base, egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", scopes: ["once"], network: "public", terminalTabId: "browser:0a1b2c3d-1" },
    })).rejects.toThrow(/not a terminal tab id/u);
    // A terminal ask may name only the conversation main bound to that terminal; this tab has no binding.
    await expect(gate.requestAndWait({
      ...base, sessionId: "session-1", egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", scopes: ["once"], network: "public", terminalTabId: TAB },
    })).rejects.toThrow(/conversation binding mismatch/u);
  });
});

describe("a workspace terminal tab's egress ask", () => {
  function makeRoutedGate(terminalSurface: ReturnType<typeof makeWebContents> | null) {
    const sessionSurface = makeWebContents();
    const resolver = vi.fn((_sessionId: string | undefined, terminalTabId?: string) =>
      (terminalTabId === undefined ? sessionSurface : terminalSurface) as never);
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(resolver, undefined, 5_000, auditLogger as never);
    return { gate, resolver, sessionSurface, auditLogger };
  }

  it("goes to the window that owns the tab, names the tab and no conversation, and offers This tab", async () => {
    const owner = makeWebContents();
    const { gate, resolver, sessionSurface } = makeRoutedGate(owner);
    const answer = createApprovalGateEgressRequester(gate)(terminalRequest());
    const card = await cardSent(owner);
    expect(card).toMatchObject({
      kind: "egress-host",
      toolName: "terminal",
      args: { host: "github.com", port: 443, tabId: TAB },
      // Host rules are shell-origin: a terminal tab's card names none to save.
      egressHost: { host: "github.com", port: 443, rule: null, scopes: ["once", "tab", "always"], network: "public", terminalTabId: TAB },
    });
    expect(card.sessionId).toBeUndefined();
    expect(resolver).toHaveBeenCalledWith(undefined, TAB);
    expect(resolver.mock.calls.every(([, tabId]) => tabId === TAB)).toBe(true);
    expect(sentApprovalCards(sessionSurface)).toEqual([]);
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", egressScope: "tab", nonce: card.nonce, hmac: card.hmac,
    }, owner as never);
    await expect(answer).resolves.toEqual({ allow: true, scope: "tab" });
  });

  it("is listed for, and answered from, only the window that owns the tab", async () => {
    const owner = makeWebContents();
    const unrelatedSurface = makeWebContents();
    const { gate, sessionSurface, auditLogger } = makeRoutedGate(owner);
    const answer = createApprovalGateEgressRequester(gate)(terminalRequest());
    let settled = false;
    void answer.then(() => { settled = true; });
    const card = await cardSent(owner);
    // A reloaded window refetching pending asks: only the owner gets the terminal's.
    expect(gate.listPendingRendererRequests(sessionSurface as never).map((r) => r.id)).toEqual([]);
    expect(gate.listPendingRendererRequests(unrelatedSurface as never).map((r) => r.id)).toEqual([]);
    expect(gate.listPendingRendererRequests(owner as never).map((r) => r.id)).toEqual([card.id]);
    // Another window's answer (even with the card's nonce and hmac) is ignored and audited.
    const decision = { requestId: card.id, choice: "allow-once" as const, egressScope: "always" as const, nonce: card.nonce, hmac: card.hmac };
    expect(gate.resolveFromDesktopRenderer(card.id, decision, sessionSurface as never)).toBeNull();
    expect(gate.resolveFromDesktopRenderer(card.id, decision, unrelatedSurface as never)).toBeNull();
    expect(gate.resolve(card.id, decision, "platform-bridge")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    const rows = auditLogger.log.mock.calls.map(([row]) => String((row as { output?: string }).output ?? ""));
    const rejections = rows.filter((row) => row.startsWith(`[approval:terminal-owner-required] ${card.id}`));
    expect(rejections).toHaveLength(3);
    expect(rejections.filter((row) => row.includes("answeredBy=platform-bridge"))).toHaveLength(1);
    // The owner can still answer it.
    gate.resolveFromDesktopRenderer(card.id, { ...decision, egressScope: "once" }, owner as never);
    await expect(answer).resolves.toEqual({ allow: true, scope: "once" });
  });

  it("is not answerable by a window once it no longer owns the tab", async () => {
    const owner = makeWebContents();
    const { gate } = makeRoutedGate(owner);
    const answer = createApprovalGateEgressRequester(gate)(terminalRequest());
    const card = await cardSent(owner);
    owner.isDestroyed.mockReturnValue(true);
    expect(gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", egressScope: "once", nonce: card.nonce, hmac: card.hmac,
    }, owner as never)).toBeNull();
    gate.disposeAll();
    await answer.catch(() => undefined);
  });

  it("is denied when no window owns the tab (never drawn in another window)", async () => {
    const { gate, sessionSurface } = makeRoutedGate(null);
    await expect(createApprovalGateEgressRequester(gate)(terminalRequest())).resolves.toEqual({
      allow: false, reason: EGRESS_APPROVAL_DENY_REASONS.rejected,
    });
    expect(sentApprovalCards(sessionSurface)).toEqual([]);
  });

  it("ends when the banner's signal is aborted (timeout or tab close)", async () => {
    const owner = makeWebContents();
    const { gate } = makeRoutedGate(owner);
    const controller = new AbortController();
    const answer = createApprovalGateEgressRequester(gate)(terminalRequest({ abortSignal: controller.signal }));
    await cardSent(owner);
    controller.abort(new Error("terminal tab closed"));
    await expect(answer).resolves.toEqual({ allow: false, reason: EGRESS_APPROVAL_DENY_REASONS.rejected });
  });
});

describe("shell egress uses the common decision pipeline", () => {
  function reviewerEvidence(level: "low" | "medium" | "high", outcome: "fresh" | "error" = "fresh"): ReviewerDispatchResult {
    return { verdict: { level, reason: "Destination review." }, outcome, cacheReason: "miss-not-found", judge: { judged: false, skip: "judge-off" } };
  }

  it("reviews a headless destination before permitting one connection", async () => {
    permissionManager.setMode("auto");
    const review = vi.spyOn(permissionManager, "dispatchReviewer").mockResolvedValue(reviewerEvidence("medium"));
    const { gate, wc } = makeGate();
    await expect(createRequester(gate, permissionManager)(egressRequest({ headless: true, approvalSurface: "unavailable" }))).resolves.toEqual({ allow: true, scope: "once", oneConnection: true });
    expect(review).toHaveBeenCalledOnce();
    expect(review.mock.calls[0][1].finalInput).toEqual({ url: "https://github.com:443/", network: "public" });
    expect(review.mock.calls[0][3]?.lane).toBe("headless");
    expect(sentApprovalCards(wc)).toEqual([]);
  });

  for (const result of ["high", "error"] as const) {
    it(`denies headless ${result} fallback with no-retry text`, async () => {
      permissionManager.setMode("auto");
      const review = vi.spyOn(permissionManager, "dispatchReviewer").mockResolvedValue(reviewerEvidence("high", result === "error" ? "error" : "fresh"));
      const { gate, wc } = makeGate();
      await expect(createRequester(gate, permissionManager)(egressRequest({ headless: true }))).resolves.toEqual({ allow: false, reason: "Nobody can approve this request; do not retry." });
      expect(review).toHaveBeenCalledOnce();
      expect(sentApprovalCards(wc)).toEqual([]);
    });
  }

  it("allow mode does not bypass an explicit shell-network deny", async () => {
    permissionManager.setMode("allow");
    permissionManager.setRules([{ pattern: "sandbox_network", action: "deny", source: "builtin" }]);
    const { gate, wc } = makeGate();
    await expect(createRequester(gate, permissionManager)(egressRequest())).resolves.toEqual({ allow: false, reason: "sandbox_network" });
    expect(sentApprovalCards(wc)).toEqual([]);
  });

  it("a physical terminal connection never enters agent policy or automatic review", async () => {
    permissionManager.setMode("allow");
    const check = vi.spyOn(permissionManager, "checkDetailed");
    const review = vi.spyOn(permissionManager, "dispatchReviewer");
    const gate = { requestAndWait: vi.fn(async () => ({ requestId: "terminal", choice: "deny-once" as const })) };
    await expect(createRequester(gate, permissionManager)(terminalRequest())).resolves.toEqual({ allow: false, reason: EGRESS_APPROVAL_DENY_REASONS.denied });
    expect(check).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(gate.requestAndWait).toHaveBeenCalledOnce();
  });

  it("a shell request without a policy manager fails clearly", async () => {
    const { gate } = makeGate();
    await expect(createRequester(gate)(egressRequest())).rejects.toThrow("Shell egress requires a permission manager");
  });
});

describe("shell egress human fallback termination", () => {
  it("returns no-retry text when an owner-away wait ends without an approver", async () => {
    const gate = { requestAndWait: vi.fn(async () => ({ requestId: "away", choice: "deny-once" as const, rememberPattern: "Nobody can approve this request; do not retry." })) };
    await expect(createRequester(gate, permissionManager)(egressRequest({ ownerUnattended: true }))).resolves.toEqual({ allow: false, reason: "Nobody can approve this request; do not retry." });
    expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ ownerUnattended: true }));
  });
});
