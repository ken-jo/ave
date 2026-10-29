import type { SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentApprovalCards } from "../../__tests__/test-helpers.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { EgressGrantStore } from "../egress-grants.js";
import { openEgressInvocation, type EgressInvocation } from "../egress-invocations.js";
import { updateApprovalSurface } from "../approval-surface-registry.js";
import {
  createEgressAskRuntimeCallback, listEgressGrants, revokeEgressGrant, setWorkerEgressAllowlists,
} from "../egress-runtime.js";

const TAB = "terminal:0a1b2c3d-1";
const OTHER_TAB = "terminal:0a1b2c3d-2";
const invocations: EgressInvocation[] = [];

function terminal(tabId = TAB, sessionId?: string): EgressInvocation {
  if (sessionId !== undefined) updateApprovalSurface({ kind: "bind-terminal-session", tabId, sessionId });
  const invocation = openEgressInvocation({ kind: "terminal", tabId, ...(sessionId === undefined ? {} : { sessionId }) });
  invocations.push(invocation);
  return invocation;
}

function runtime() {
  const wc = { send: vi.fn(), isDestroyed: () => false };
  const gate = new ApprovalGate(wc as never, undefined, 5_000, { log: vi.fn() } as never);
  const callback = createEgressAskRuntimeCallback({ approvalGate: gate, shellAskEnabled: () => true });
  const cards = () => sentApprovalCards<ApprovalRequest>(wc);
  const cardSent = async (count: number) => {
    await vi.waitFor(() => expect(cards()).toHaveLength(count));
    return cards()[count - 1]!;
  };
  const answer = (card: ApprovalRequest, scope: "once" | "tab" | "always" | "deny") => {
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, nonce: card.nonce, hmac: card.hmac,
      choice: scope === "deny" ? "deny-once" : "allow-once",
      ...(scope === "deny" ? {} : { egressScope: scope }),
    }, wc as never);
  };
  return { callback, cards, cardSent, answer };
}

async function connect(callback: SandboxAskCallback, token: string, host: string) {
  const destination = { host, port: 443 };
  const who = { attributionKey: token, identity: "listener" as const };
  const name = await callback(destination, { ...who, phase: "name" });
  return name === true
    ? callback(destination, { ...who, phase: "resolved", addresses: ["93.184.215.14"], resolution: "pinned" })
    : name;
}

afterEach(async () => {
  for (const invocation of invocations.splice(0)) {
    if (invocation.owner.kind === "terminal") updateApprovalSurface({ kind: "release-terminal", tabId: invocation.owner.tabId });
    invocation.release();
  }
  for (const grant of await listEgressGrants()) await revokeEgressGrant(grant);
  setWorkerEgressAllowlists({ byExtension: new Map(), modelEndpointHosts: [] });
});

describe("terminal egress through the production runtime callback and approval gate", () => {
  it("refuses a terminal card whose main-owned conversation binding changed", async () => {
    const invocation = terminal(TAB, "conversation-owner");
    const { callback, cards } = runtime();
    updateApprovalSurface({ kind: "bind-terminal-session", tabId: TAB, sessionId: "different-conversation" });
    await expect(connect(callback, invocation.token, "mismatch.example")).resolves.toMatchObject({ allow: false,
      reason: expect.stringContaining("terminal egress conversation binding mismatch") });
    expect(cards()).toEqual([]);
    updateApprovalSurface({ kind: "release-terminal", tabId: TAB });
  });
  it("keeps the owning conversation on terminal egress cards without changing grant scopes", async () => {
    const invocation = terminal(TAB, "conversation-owner");
    const { callback, cards, answer } = runtime();
    let settled: unknown;
    const pending = connect(callback, invocation.token, "conversation.example").then((result) => { settled = result; return result; });
    await vi.waitFor(() => expect(cards(), JSON.stringify(settled)).toHaveLength(1));
    const card = cards()[0]!;
    expect(card).toMatchObject({ sessionId: "conversation-owner", egressHost: { terminalTabId: TAB } });
    expect(card.egressHost?.scopes).toEqual(process.platform === "win32" ? ["once", "tab"] : ["once", "tab", "always"]);
    answer(card, "once");
    await expect(pending).resolves.toBe(true);
  });
  it.each(["manifest.example", "models.example", "unknown.example"])("asks for %s without inheriting worker domains", async (host) => {
    setWorkerEgressAllowlists({
      byExtension: new Map([["fixture-plugin", ["manifest.example"]]]),
      modelEndpointHosts: ["models.example"],
    });
    const invocation = terminal();
    const { callback, cardSent, answer, cards } = runtime();
    const first = connect(callback, invocation.token, host);
    const card = await cardSent(1);
    expect(card).toMatchObject({
      kind: "egress-host", toolName: "terminal", args: { host, port: 443, tabId: TAB },
      allowedChoices: ["allow-once", "deny-once"],
      egressHost: { host, port: 443, terminalTabId: TAB, network: "public" },
    });
    expect(card.egressHost?.scopes).toEqual(process.platform === "win32" ? ["once", "tab"] : ["once", "tab", "always"]);
    answer(card, "once");
    await expect(first).resolves.toBe(true);
    expect(await listEgressGrants()).toEqual([]);
    const next = connect(callback, invocation.token, host);
    answer(await cardSent(2), "deny");
    await expect(next).resolves.toEqual({ allow: false, reason: "denied by the user" });
    expect(cards()).toHaveLength(2);
  });

  it("reuses This tab only in that tab, revokes it, and drops it when the tab exits", async () => {
    const invocation = terminal();
    const other = terminal(OTHER_TAB);
    const { callback, cardSent, answer, cards } = runtime();
    const first = connect(callback, invocation.token, "tab.example");
    answer(await cardSent(1), "tab");
    await expect(first).resolves.toBe(true);
    await expect(connect(callback, invocation.token, "tab.example")).resolves.toBe(true);
    expect(cards()).toHaveLength(1);
    const target = { scope: "tab" as const, tabId: TAB, host: "tab.example", port: 443, network: "public" as const };
    expect(await listEgressGrants()).toContainEqual(expect.objectContaining(target));
    const foreign = connect(callback, other.token, "tab.example");
    answer(await cardSent(2), "deny");
    await expect(foreign).resolves.toMatchObject({ allow: false });
    expect((await revokeEgressGrant(target)).removed).toBe(true);
    const revoked = connect(callback, invocation.token, "tab.example");
    answer(await cardSent(3), "tab");
    await expect(revoked).resolves.toBe(true);
    invocation.release();
    expect(await listEgressGrants()).not.toContainEqual(expect.objectContaining(target));
    const respawn = terminal();
    const afterExit = connect(callback, respawn.token, "tab.example");
    answer(await cardSent(4), "deny");
    await expect(afterExit).resolves.toMatchObject({ allow: false });
  });

  it.skipIf(process.platform === "win32")("persists terminal Always across tabs and callbacks until revoked without granting shell calls", async () => {
    const first = terminal();
    const second = terminal(OTHER_TAB);
    const firstRuntime = runtime();
    const initial = connect(firstRuntime.callback, first.token, "persistent.example");
    firstRuntime.answer(await firstRuntime.cardSent(1), "always");
    await expect(initial).resolves.toBe(true);
    const target = { scope: "always" as const, origin: "terminal" as const, host: "persistent.example", port: 443, network: "public" as const };
    expect(await new EgressGrantStore().listPersistent()).toContainEqual(expect.objectContaining(target));
    first.release();
    const nextRuntime = runtime();
    await expect(connect(nextRuntime.callback, second.token, target.host)).resolves.toBe(true);
    expect(nextRuntime.cards()).toEqual([]);
    const shell = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: "terminal-origin-test", workspaceRoot: undefined, approvalSurface: "interactive" } });
    invocations.push(shell);
    const shellAttempt = connect(nextRuntime.callback, shell.token, target.host);
    nextRuntime.answer(await nextRuntime.cardSent(1), "deny");
    await expect(shellAttempt).resolves.toMatchObject({ allow: false });
    expect((await revokeEgressGrant(target)).removed).toBe(true);
    expect(await new EgressGrantStore().listPersistent()).not.toContainEqual(expect.objectContaining(target));
    const revoked = connect(nextRuntime.callback, second.token, target.host);
    nextRuntime.answer(await nextRuntime.cardSent(2), "deny");
    await expect(revoked).resolves.toMatchObject({ allow: false });
  });
});
