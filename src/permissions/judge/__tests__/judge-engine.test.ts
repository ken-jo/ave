import { describe, expect, it } from "vitest";
import { JudgeContractError, JudgeFailure, type JudgeRequest, type JudgeVerdict, type PermissionJudge } from "../judge-contract.js";
import { JudgeCircuitBreaker } from "../judge-breaker.js";
import { POLICY_REDACTED, resolveJudge, type JudgeEngineDeps, type JudgeGate, type JudgeHooks } from "../judge-engine.js";
import type { JudgeSettings } from "../judge-settings.js";
import {
  PLANTED_CREDENTIAL,
  auditPayload,
  collectingAudit,
  judgeInvocation,
  judgeRecords,
  type CollectingAudit,
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
): JudgeEngineDeps & Pick<CollectingAudit, "entries" | "chained"> {
  const s = judgeSettings(settings);
  const { entries, chained, logger } = collectingAudit();
  const chain = s.chain.map((stage) => ({ settings: stage, judge }));
  return { settings: s, chain, breaker: new JudgeCircuitBreaker(s.breaker), audit: logger, entries, chained, ...(hooks ? { hooks } : {}) };
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
    expect(judgeRecords(d)).toHaveLength(0);
  });

  it("an empty chain is today's behavior: never runs", async () => {
    const judge = answering(ALLOW);
    const out = await resolveJudge(UNDECIDED, judgeRequest(), deps(judge, { chain: [] }));
    expect(out).toEqual({ judged: false, skip: "judge-off" });
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
    expect(out).toMatchObject({ judged: true, decision: "allow", applied: true, source: "judge", suggestedRule: "Bash(npm run *)" });
  });

  it("shadow mode runs and audits but is not applied", async () => {
    const d = deps(answering(ALLOW), { mode: "shadow" });
    const out = await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(out).toMatchObject({ judged: true, decision: "allow", applied: false });
    expect(auditPayload(d.entries[0]!)).toMatchObject({ mode: "shadow", applied: false, decision: "allow" });
  });

  it("shadow headless denial never creates denial history", async () => {
    const d = deps(answering(DENY), { mode: "shadow" });
    const out = await resolveJudge(UNDECIDED, judgeRequest({ lane: "headless" }), d);
    expect(out).toMatchObject({ judged: true, decision: "deny", applied: false, });
    if (!out.judged) throw new Error("expected judged");
    expect(out.recentlyDenied).toBeUndefined();
  });

  it("headless ask becomes deny with redacted history metadata", async () => {
    const d = deps(answering({ decision: "ask", rationale: "unsure" }));
    const out = await resolveJudge(UNDECIDED, judgeRequest({ lane: "headless" }), d);
    expect(out).toMatchObject({ judged: true, decision: "deny", });
    if (!out.judged) throw new Error("expected judged");
    expect(out.recentlyDenied?.verdict.level).toBe("high");
    expect(out.rationale).toBe("Nobody can approve this request; do not retry.");
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
      expect(out).toMatchObject({ judged: true, decision: "ask", source: "fallback", fallback: kind });
      expect(judgeRecords(d)[0]).toMatchObject({ fallback: kind, decision: "ask" });
    });
    it(`${label}: headless → deny with denial history`, async () => {
      const d = deps(make(), { timeoutMs: 30 });
      const out = await resolveJudge(UNDECIDED, judgeRequest({ lane: "headless" }), d);
      expect(out).toMatchObject({ judged: true, decision: "deny", source: "fallback", fallback: kind });
    });
  }

  it("an already-aborted caller never starts the judge and writes no audit", async () => {
    const judge = answering(ALLOW);
    const d = deps(judge);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before review"));
    await expect(resolveJudge(UNDECIDED, judgeRequest(), d, controller.signal)).rejects.toThrow("cancelled before review");
    expect(judge.calls).toBe(0);
    expect(judgeRecords(d)).toHaveLength(0);
  });

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

  it("beforeJudge may hide input values from the judge; the audit still describes the real call", async () => {
    let seen: Record<string, unknown> = {};
    const judge: PermissionJudge = {
      id: "seeing",
      version: "t1",
      judge: async (req) => {
        seen = req.invocation.finalInput;
        return ALLOW;
      },
    };
    const d = deps(judge, {}, { beforeJudge: () => ({ action: "continue", redactInputKeys: ["command"] }) });
    const real = judgeRequest();
    await resolveJudge(UNDECIDED, real, d);
    expect(seen).toEqual({ command: POLICY_REDACTED });
    expect(real.invocation.finalInput).toEqual({ command: "npm run build" });
    const record = judgeRecords(d)[0]!;
    expect(record.policyRedactedKeys).toEqual(["command"]);
    expect((record.redactedRequest as { tool: { input: Record<string, string> } }).tool.input.command).toBe("npm run build");

    const unredacted = deps(answering(ALLOW));
    await resolveJudge(UNDECIDED, judgeRequest(), unredacted);
    expect(judgeRecords(unredacted)[0]!.argsHash).toBe(record.argsHash);
  });

  it("beforeJudge cannot change what executes or what the judge sees except by redaction", async () => {
    let seen: JudgeRequest | null = null;
    const judge: PermissionJudge = {
      id: "seeing",
      version: "t1",
      judge: async (req) => {
        seen = req;
        return ALLOW;
      },
    };
    const d = deps(judge, {}, {
      beforeJudge: (req) => {
        const mutable = req as JudgeRequest;
        mutable.invocation.finalInput.command = "echo harmless";
        (mutable.invocation as { executionCwd: string }).executionCwd = "/elsewhere";
        mutable.ruleVerdict = { level: "low", reason: "forged" };
        mutable.policy = { mode: "yolo" };
        return { action: "continue" };
      },
    });
    const real = judgeRequest();
    await resolveJudge(UNDECIDED, real, d);
    expect(seen).toBe(real);
    expect(real.invocation.finalInput.command).toBe("npm run build");
    expect(real.invocation.executionCwd).toBe("/workspace/sample");
    expect(real.ruleVerdict.reason).toBe("shell command");
    expect(real.policy.mode).toBe("ask");

    const unknownKey = deps(answering(ALLOW), {}, { beforeJudge: () => ({ action: "continue", redactInputKeys: ["nope"] }) });
    await expect(resolveJudge(UNDECIDED, judgeRequest(), unknownKey)).rejects.toBeInstanceOf(JudgeContractError);
  });
});

describe("resolveJudge — circuit breaker", () => {
  it.each(["foreground", "headless"] as const)("three consecutive blocks pause the threshold-triggering %s request", async (lane) => {
    const provider = answering(DENY);
    const d = deps(provider);
    const request = judgeRequest({ lane });
    for (let i = 0; i < 2; i++) {
      expect(await resolveJudge(UNDECIDED, judgeRequest({ lane }), d)).toMatchObject({ decision: "deny", source: "judge" });
    }
    const paused = {
      judged: true, source: "breaker", pause: "consecutive",
      decision: lane === "foreground" ? "ask" : "deny", applied: true,
    };
    expect(await resolveJudge(UNDECIDED, judgeRequest({ lane }), d)).toMatchObject({ ...paused, breakerTripped: true });
    expect(await resolveJudge(UNDECIDED, judgeRequest({ lane }), d)).toMatchObject({ ...paused, breakerTripped: false });
    expect(provider.calls).toBe(3);
    expect(judgeRecords(d).at(-1)).toMatchObject({
      source: "breaker", pause: "consecutive", stages: [],
      rationale: "Automated approval paused: 3 consecutive classifier blocks",
    });
    // A subagent keyed by the same root session shares the pause.
    expect(await resolveJudge(UNDECIDED, { ...request, sessionId: "session-root" }, d)).toMatchObject(paused);
    // Another session is unaffected.
    expect((await resolveJudge(UNDECIDED, judgeRequest({ sessionId: "other" }), d)).judged).toBe(true);
  });

  it.each(["foreground", "headless"] as const)("twenty total blocks pause %s and reset only the total counter", async (lane) => {
    let n = 0;
    const provider = answering(async () => (n++ % 2 === 0 ? DENY : ALLOW));
    const d = deps(provider);
    for (let i = 0; i < 38; i++) await resolveJudge(UNDECIDED, judgeRequest({ lane }), d);
    expect(d.breaker.snapshot("session-root")).toEqual({ consecutive: 0, total: 19, open: false });
    expect(await resolveJudge(UNDECIDED, judgeRequest({ lane }), d)).toMatchObject({
      judged: true, source: "breaker", pause: "total", breakerTripped: true,
      decision: lane === "foreground" ? "ask" : "deny",
      rationale: lane === "headless" ? "Nobody can approve this request; do not retry." : "Automated approval paused: 20 total classifier blocks",
    });
    expect(d.breaker.snapshot("session-root")).toEqual({ consecutive: 1, total: 20, open: true });
    expect(await resolveJudge(UNDECIDED, judgeRequest({ lane }), d)).toMatchObject({
      judged: true, source: "breaker", pause: "total", breakerTripped: false,
      decision: lane === "foreground" ? "ask" : "deny",
    });
    expect(provider.calls).toBe(39);
    d.breaker.beginTurn("session-root");
    expect(await resolveJudge(UNDECIDED, judgeRequest({ lane }), d)).toMatchObject({ decision: "allow", source: "judge" });
    expect(provider.calls).toBe(40);
    expect(d.breaker.snapshot("session-root")).toEqual({ consecutive: 0, total: 0, open: false });
  });

  it("a final ask is a classifier block and a new turn resumes the next review", async () => {
    let allowed = false;
    const provider = answering(async () => allowed ? ALLOW : { decision: "ask", rationale: "needs approval" });
    const d = deps(provider);
    const request = judgeRequest();
    for (let i = 0; i < 2; i++) {
      expect(await resolveJudge(UNDECIDED, judgeRequest(), d)).toMatchObject({ decision: "ask", source: "judge" });
    }
    expect(await resolveJudge(UNDECIDED, judgeRequest(), d)).toMatchObject({
      decision: "ask", source: "breaker", pause: "consecutive", breakerTripped: true,
    });
    d.breaker.beginTurn(request.sessionId);
    expect(d.breaker.snapshot(request.sessionId)).toEqual({ consecutive: 0, total: 0, open: false });
    allowed = true;
    expect(await resolveJudge(UNDECIDED, judgeRequest(), d)).toMatchObject({ decision: "allow", source: "judge" });
    expect(d.breaker.snapshot(request.sessionId)).toEqual({ consecutive: 0, total: 0, open: false });
    expect(provider.calls).toBe(4);
  });

  it("host hooks do not manufacture classifier blocks", async () => {
    const before = deps(answering(DENY), {}, {
      beforeJudge: () => ({ action: "short-circuit", decision: "deny", reason: "host refusal" }),
    });
    const after = deps(answering(ALLOW), {}, { afterJudge: () => "deny" });
    for (let i = 0; i < 4; i++) {
      await resolveJudge(UNDECIDED, judgeRequest(), before);
      await resolveJudge(UNDECIDED, judgeRequest(), after);
    }
    expect(before.breaker.snapshot("session-root")).toEqual({ consecutive: 0, total: 0, open: false });
    expect(after.breaker.snapshot("session-root")).toEqual({ consecutive: 0, total: 0, open: false });
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
  it("active decisions go to the HMAC chain, shadow rows to the plain channel", async () => {
    const active = deps(answering(ALLOW));
    await resolveJudge(UNDECIDED, judgeRequest(), active);
    expect(active.entries).toHaveLength(0);
    expect(active.chained).toHaveLength(1);
    expect(active.chained[0]).toMatchObject({ decision: "judge", tool: "bash", source: "builtin", category: "shell" });

    const shadow = deps(answering(ALLOW), { mode: "shadow" });
    await resolveJudge(UNDECIDED, judgeRequest(), shadow);
    expect(shadow.chained).toHaveLength(0);
    expect(shadow.entries).toHaveLength(1);
  });

  it("an unwritable integrity channel fails the active call clearly", async () => {
    const d = deps(answering(ALLOW));
    d.audit = { ...d.audit, appendPermissionAuditEntry: () => Promise.reject(new Error("permission audit chain not initialized")) };
    await expect(resolveJudge(UNDECIDED, judgeRequest(), d)).rejects.toThrow("not initialized");
  });

  it("writes one redacted record per judged call, including provider stderr", async () => {
    const d = deps(answering({ decision: "allow", rationale: `saw ${PLANTED_CREDENTIAL}`, diagnostics: { stderr: `warn ${PLANTED_CREDENTIAL}` } }));
    const request = judgeRequest({
      invocation: judgeInvocation({ finalInput: { command: `curl -H "Authorization: token ${PLANTED_CREDENTIAL}" x` } }),
      recentUserMessages: [`my token is ${PLANTED_CREDENTIAL}`],
    });
    const out = await resolveJudge(UNDECIDED, request, d);
    expect(out).toMatchObject({ decision: "allow" });
    const records = judgeRecords(d);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(d.chained)).not.toContain(PLANTED_CREDENTIAL);
    expect(records[0]).toMatchObject({
      event: "permission-judge",
      session: "session-root",
      tool: "bash",
      judge: { id: "scripted", version: "t1" },
      verdictDecision: "allow",
      fallback: null,
    });
    const stage = (records[0]!.stages as Array<Record<string, unknown>>)[0]!;
    expect(String(stage.stderr)).toContain("warn");
    expect(String(stage.stderr)).not.toContain(PLANTED_CREDENTIAL);
    expect(typeof records[0]!.argsHash).toBe("string");
    expect(typeof records[0]!.latencyMs).toBe("number");
  });
});

describe("shared pause across concurrent reviews", () => {
  it.each(["provider", "audit"] as const)("replaces an in-flight allow when a sibling trips the breaker during %s", async (boundary) => {
    let reached!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const d = deps(answering(async () => {
      if (boundary === "provider") { reached(); await held; }
      return ALLOW;
    }));
    if (boundary === "audit") {
      const append = d.audit.appendPermissionAuditEntry.bind(d.audit);
      d.audit = {
        ...d.audit,
        async appendPermissionAuditEntry(entry) {
          reached();
          await held;
          return append(entry);
        },
      };
    }
    const pending = resolveJudge(UNDECIDED, judgeRequest(), d);
    await started;
    const sibling = { ...deps(answering(DENY)), breaker: d.breaker };
    for (let call = 0; call < 3; call += 1) await resolveJudge(UNDECIDED, judgeRequest(), sibling);
    release();
    expect(await pending).toMatchObject({ decision: "ask", pause: "consecutive", source: "breaker" });
    expect(d.breaker.snapshot("session-root")).toEqual({ consecutive: 3, total: 3, open: true });
    expect(judgeRecords(d).at(-1)).toMatchObject({ decision: "ask", pause: "consecutive" });
  });

  it("does not count a block after caller cancellation during a host hook", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped review");
    const d = deps(answering(DENY), {}, {
      afterJudge() { controller.abort(reason); return "deny"; },
    });
    await expect(resolveJudge(UNDECIDED, judgeRequest(), d, controller.signal)).rejects.toBe(reason);
    expect(d.breaker.snapshot("session-root")).toEqual({ consecutive: 0, total: 0, open: false });
    expect(judgeRecords(d)).toHaveLength(0);
  });
});

it("retains a completed classifier block when the caller stops during its audit write", async () => {
  const controller = new AbortController();
  const reason = new Error("caller stopped during audit");
  const d = deps(answering(DENY));
  for (let block = 0; block < 19; block += 1) {
    d.breaker.record("session-root", "deny", `completed-block-${block}`);
    d.breaker.record("session-root", "allow", `allowed-after-block-${block}`);
  }
  const append = d.audit.appendPermissionAuditEntry.bind(d.audit);
  d.audit = {
    ...d.audit,
    async appendPermissionAuditEntry(entry) {
      controller.abort(reason);
      return append(entry);
    },
  };
  await expect(resolveJudge(UNDECIDED, judgeRequest(), d, controller.signal)).rejects.toBe(reason);
  expect(d.breaker.snapshot("session-root")).toEqual({ consecutive: 1, total: 20, open: true });
  expect(d.breaker.pauseReason("session-root")).toBe("total");
});
