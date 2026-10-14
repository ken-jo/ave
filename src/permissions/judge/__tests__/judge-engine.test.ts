import { describe, expect, it } from "vitest";
import { JudgeContractError, JudgeFailure, type JudgeVerdict, type PermissionJudge } from "../judge-contract.js";
import { JudgeCircuitBreaker } from "../judge-breaker.js";
import { resolveJudge, type JudgeEngineDeps, type JudgeGate, type JudgeHooks } from "../judge-engine.js";
import type { JudgeSettings } from "../judge-settings.js";
import {
  PLANTED_CREDENTIAL,
  auditPayload,
  collectingAudit,
  judgeInvocation,
  judgeRequest,
  judgeSettings,
} from "./judge-request-fixture.js";

const UNDECIDED: JudgeGate = { priorDecision: "undecided", strictMode: false, capabilityGrant: false, remoteController: false };

function answering(verdict: JudgeVerdict | (() => Promise<JudgeVerdict>)): PermissionJudge & { calls: number } {
  const judge = {
    id: "scripted",
    version: "t1",
    calls: 0,
    async judge(): Promise<JudgeVerdict> {
      judge.calls += 1;
      return typeof verdict === "function" ? verdict() : verdict;
    },
  };
  return judge;
}

function failing(err: unknown): PermissionJudge {
  return { id: "failing", version: "t1", judge: async () => Promise.reject(err) };
}

function deps(
  judge: PermissionJudge | null,
  settings: Partial<JudgeSettings> = {},
  hooks?: JudgeHooks,
): JudgeEngineDeps & { audit: ReturnType<typeof collectingAudit>["logger"]; entries: ReturnType<typeof collectingAudit>["entries"] } {
  const s = judgeSettings(settings);
  const { entries, logger } = collectingAudit();
  return { settings: s, judge, breaker: new JudgeCircuitBreaker(s.breaker), audit: logger, entries, ...(hooks ? { hooks } : {}) };
}

const ALLOW: JudgeVerdict = { decision: "allow", rationale: "build script" };
const DENY: JudgeVerdict = { decision: "deny", rationale: "destructive" };

describe("resolveJudge — placement", () => {
  it.each(["allow", "ask", "deny"] as const)("never runs when rules already decided (%s)", async (prior) => {
    const judge = answering(ALLOW);
    const d = deps(judge);
    const out = await resolveJudge({ ...UNDECIDED, priorDecision: prior }, judgeRequest(), d);
    expect(out).toEqual({ judged: false, skip: "rule-decided" });
    expect(judge.calls).toBe(0);
    expect(d.entries).toHaveLength(0);
  });

  it("provider off is today's behavior: never runs", async () => {
    const judge = answering(ALLOW);
    const out = await resolveJudge(UNDECIDED, judgeRequest(), deps(judge, { provider: "off" }));
    expect(out).toEqual({ judged: false, skip: "provider-off" });
    expect(judge.calls).toBe(0);
  });

  it.each([
    ["strictMode", "strict-mode"],
    ["capabilityGrant", "capability-grant"],
    ["remoteController", "remote-controller"],
  ] as const)("never decides %s", async (flag, skip) => {
    const judge = answering(ALLOW);
    const out = await resolveJudge({ ...UNDECIDED, [flag]: true }, judgeRequest(), deps(judge));
    expect(out).toEqual({ judged: false, skip });
    expect(judge.calls).toBe(0);
  });

  it("per-category enablement: network off by default, read/meta never judged", async () => {
    const judge = answering(ALLOW);
    const net = judgeRequest({ invocation: judgeInvocation({ category: "network", toolName: "web_fetch" }) });
    expect(await resolveJudge(UNDECIDED, net, deps(judge))).toEqual({ judged: false, skip: "category-disabled" });
    const read = judgeRequest({ invocation: judgeInvocation({ category: "read", toolName: "read_file" }) });
    expect(await resolveJudge(UNDECIDED, read, deps(judge))).toEqual({ judged: false, skip: "category-not-judged" });
    const enabled = await resolveJudge(
      UNDECIDED,
      net,
      deps(judge, { categories: { shell: true, write: true, network: true } }),
    );
    expect(enabled.judged).toBe(true);
  });

  it("active allow is applied; suggestion is passed through, never persisted", async () => {
    const d = deps(answering({ ...ALLOW, suggestedRule: "Bash(npm run *)" }));
    const out = await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(out).toMatchObject({ judged: true, decision: "allow", applied: true, defer: false, source: "judge", suggestedRule: "Bash(npm run *)" });
  });

  it("shadow mode runs and audits but is not applied", async () => {
    const d = deps(answering(ALLOW), { mode: "shadow" });
    const out = await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(out).toMatchObject({ judged: true, decision: "allow", applied: false });
    expect(auditPayload(d.entries[0]!)).toMatchObject({ mode: "shadow", applied: false, decision: "allow" });
  });

  it("shadow headless denial never asks the call site to defer", async () => {
    const d = deps(answering(DENY), { mode: "shadow" });
    const out = await resolveJudge(UNDECIDED, judgeRequest({ lane: "headless" }), d);
    expect(out).toMatchObject({ judged: true, decision: "deny", applied: false, defer: false });
    if (!out.judged) throw new Error("expected judged");
    expect(out.deferral).toBeUndefined();
  });

  it("headless ask becomes deny + deferral", async () => {
    const d = deps(answering({ decision: "ask", rationale: "unsure" }));
    const out = await resolveJudge(UNDECIDED, judgeRequest({ lane: "headless" }), d);
    expect(out).toMatchObject({ judged: true, decision: "deny", defer: true });
    if (!out.judged) throw new Error("expected judged");
    expect(out.deferral?.verdict.level).toBe("high");
  });
});

describe("resolveJudge — fallbacks never allow", () => {
  const causes: Array<[string, () => PermissionJudge | null, string]> = [
    ["error", () => failing(new Error("boom")), "error"],
    ["typed error", () => failing(new JudgeFailure("error", "provider 500")), "error"],
    ["unparseable", () => failing(new JudgeFailure("unparseable", "garbage")), "unparseable"],
    ["unavailable", () => null, "unavailable"],
    ["timeout", () => answering(() => new Promise<JudgeVerdict>(() => {})), "timeout"],
  ];
  for (const [label, make, kind] of causes) {
    it(`${label}: foreground → ask`, async () => {
      const d = deps(make(), { timeoutMs: 30 });
      const out = await resolveJudge(UNDECIDED, judgeRequest(), d);
      expect(out).toMatchObject({ judged: true, decision: "ask", defer: false, source: "fallback", fallback: kind });
      expect(auditPayload(d.entries[0]!)).toMatchObject({ fallback: kind, decision: "ask" });
    });
    it(`${label}: headless → deny + defer`, async () => {
      const d = deps(make(), { timeoutMs: 30 });
      const out = await resolveJudge(UNDECIDED, judgeRequest({ lane: "headless" }), d);
      expect(out).toMatchObject({ judged: true, decision: "deny", defer: true, source: "fallback", fallback: kind });
    });
  }

  it("a caller abort propagates instead of becoming a verdict", async () => {
    const controller = new AbortController();
    const d = deps(answering(() => new Promise<JudgeVerdict>(() => {})));
    const pending = resolveJudge(UNDECIDED, judgeRequest(), d, controller.signal);
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toThrow("user cancelled");
  });
});

describe("resolveJudge — hooks", () => {
  it.each([
    ["allow", "ask"],
    ["allow", "deny"],
    ["ask", "deny"],
    ["deny", "deny"],
  ] as const)("afterJudge may downgrade %s → %s", async (from, to) => {
    const d = deps(answering({ decision: from, rationale: "r" }), {}, { afterJudge: () => to });
    const out = await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(out).toMatchObject({ decision: to });
  });

  it.each([
    ["deny", "allow"],
    ["deny", "ask"],
    ["ask", "allow"],
  ] as const)("afterJudge upgrade %s → %s is a contract error", async (from, to) => {
    const d = deps(answering({ decision: from, rationale: "r" }), {}, { afterJudge: () => to });
    await expect(resolveJudge(UNDECIDED, judgeRequest(), d)).rejects.toBeInstanceOf(JudgeContractError);
  });

  it("beforeJudge short-circuit skips the judge", async () => {
    const judge = answering(ALLOW);
    const d = deps(judge, {}, { beforeJudge: () => ({ action: "short-circuit", decision: "deny", reason: "policy" }) });
    const out = await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(out).toMatchObject({ decision: "deny", source: "hook" });
    expect(judge.calls).toBe(0);
  });

  it("beforeJudge may redact but not swap the call", async () => {
    const swap = deps(answering(ALLOW), {}, {
      beforeJudge: (req) => ({ action: "continue", request: { ...req, invocation: { ...req.invocation, toolName: "other" } } }),
    });
    await expect(resolveJudge(UNDECIDED, judgeRequest(), swap)).rejects.toBeInstanceOf(JudgeContractError);

    let seen = "";
    const judge: PermissionJudge = {
      id: "seeing",
      version: "t1",
      judge: async (req) => {
        seen = String(req.invocation.finalInput.command);
        return ALLOW;
      },
    };
    const redact = deps(judge, {}, {
      beforeJudge: (req) => ({
        action: "continue",
        request: { ...req, invocation: { ...req.invocation, finalInput: { command: "[redacted]" } } },
      }),
    });
    await resolveJudge(UNDECIDED, judgeRequest(), redact);
    expect(seen).toBe("[redacted]");
  });
});

describe("resolveJudge — circuit breaker", () => {
  it("3 consecutive judge denials pause automation for the session", async () => {
    const d = deps(answering(DENY));
    for (let i = 0; i < 3; i++) await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(await resolveJudge(UNDECIDED, judgeRequest(), d)).toEqual({ judged: false, skip: "breaker-open" });
    // A subagent keyed by the same root session shares the pause.
    expect(await resolveJudge(UNDECIDED, judgeRequest({ sessionId: "session-root" }), d)).toEqual({ judged: false, skip: "breaker-open" });
    // Another session is unaffected.
    expect((await resolveJudge(UNDECIDED, judgeRequest({ sessionId: "other" }), d)).judged).toBe(true);
  });

  it("fallbacks and timeouts do not count as denials; shadow never trips", async () => {
    const timeouts = deps(answering(() => new Promise<JudgeVerdict>(() => {})), { timeoutMs: 10 });
    for (let i = 0; i < 4; i++) await resolveJudge(UNDECIDED, judgeRequest(), timeouts);
    expect(timeouts.breaker.snapshot("session-root").total).toBe(0);

    const shadow = deps(answering(DENY), { mode: "shadow" });
    for (let i = 0; i < 4; i++) await resolveJudge(UNDECIDED, judgeRequest(), shadow);
    expect(shadow.breaker.isOpen("session-root")).toBe(false);
  });
});

describe("resolveJudge — audit", () => {
  it("writes one redacted record per judged call", async () => {
    const d = deps(answering({ decision: "allow", rationale: `saw ${PLANTED_CREDENTIAL}` }));
    const request = judgeRequest({
      invocation: judgeInvocation({ finalInput: { command: `curl -H "Authorization: token ${PLANTED_CREDENTIAL}" x` } }),
      recentUserMessages: [`my token is ${PLANTED_CREDENTIAL}`],
    });
    await resolveJudge(UNDECIDED, request, d);
    expect(d.entries).toHaveLength(1);
    const line = JSON.stringify(d.entries[0]);
    expect(line).not.toContain(PLANTED_CREDENTIAL);
    const record = auditPayload(d.entries[0]!);
    expect(record).toMatchObject({
      event: "permission-judge",
      session: "session-root",
      tool: "bash",
      judge: { id: "scripted", version: "t1" },
      verdictDecision: "allow",
      fallback: null,
    });
    expect(typeof record.argsHash).toBe("string");
    expect(typeof record.latencyMs).toBe("number");
  });
});
