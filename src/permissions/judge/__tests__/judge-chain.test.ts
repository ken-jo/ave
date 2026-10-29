import { describe, expect, it } from "vitest";
import { llmVendorModelOptions } from "../../../shared/llm-vendor-defaults.js";
import { JudgeFailure, type JudgeVerdict, type PermissionJudge } from "../judge-contract.js";
import { JudgeCircuitBreaker } from "../judge-breaker.js";
import { resolveJudge, type JudgeChainStage, type JudgeEngineDeps, type JudgeGate } from "../judge-engine.js";
import type { JudgeSettings, JudgeStageSettings } from "../judge-settings.js";
import { collectingAudit, judgeRecords, judgeRequest, judgeSettings, scriptedStage, type CollectingAudit } from "./judge-request-fixture.js";

const UNDECIDED: JudgeGate = { priorDecision: "undecided", strictMode: false, capabilityGrant: false, remoteController: false };
const PICKER_MODEL = llmVendorModelOptions("claude")[0]!;

type Script = JudgeVerdict | Error;

function scripted(id: string, ...answers: Script[]): PermissionJudge & { calls: number } {
  const judge = {
    id,
    version: `${id}-v1`,
    calls: 0,
    async judge(): Promise<JudgeVerdict> {
      const answer = answers[Math.min(judge.calls, answers.length - 1)]!;
      judge.calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return judge;
}

function chainDeps(
  stages: Array<[JudgeStageSettings, PermissionJudge | null]>,
  settings: Partial<JudgeSettings> = {},
): JudgeEngineDeps & Pick<CollectingAudit, "entries" | "chained"> {
  const s = judgeSettings({ ...settings, chain: stages.map(([stage]) => stage) });
  const chain: JudgeChainStage[] = stages.map(([stage, judge]) => ({ settings: stage, judge }));
  const { entries, chained, logger } = collectingAudit();
  return { settings: s, chain, breaker: new JudgeCircuitBreaker(s.breaker), audit: logger, entries, chained };
}

const builtinStage = (): JudgeStageSettings => ({ provider: "builtin-llm", id: "llm", model: { vendor: "claude", model: PICKER_MODEL } });
const v = (decision: JudgeVerdict["decision"], confidence?: number): JudgeVerdict => ({
  decision,
  rationale: `${decision}${confidence === undefined ? "" : `@${confidence}`}`,
  ...(confidence === undefined ? {} : { confidence }),
});

describe("judge chain — escalation", () => {
  it("a fast stage's confident allow is final; later stages never run", async () => {
    const jev = scripted("jev", v("allow", 0.95));
    const llm = scripted("llm", v("deny"));
    const out = await resolveJudge(UNDECIDED, judgeRequest(), chainDeps([[scriptedStage("jev", 0.8), jev], [builtinStage(), llm]]));
    expect(out).toMatchObject({ judged: true, decision: "allow", decidedBy: "jev" });
    expect(llm.calls).toBe(0);
  });

  it("a fast stage's ask escalates to the LLM stage", async () => {
    const jev = scripted("jev", v("ask", 0.99));
    const llm = scripted("llm", v("deny"));
    const d = chainDeps([[scriptedStage("jev", 0.8), jev], [builtinStage(), llm]]);
    const out = await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(out).toMatchObject({ decision: "deny", decidedBy: "llm", source: "judge" });
    const stages = judgeRecords(d)[0]!.stages as Array<Record<string, unknown>>;
    expect(stages.map((s) => [s.id, s.outcome, s.decision])).toEqual([
      ["jev", "escalated", "ask"],
      ["llm", "decided", "deny"],
    ]);
    expect(stages[1]).toMatchObject({ model: `claude/${PICKER_MODEL}`, version: "llm-v1", confidence: null });
    expect(stages[0]).toMatchObject({ model: null, confidence: 0.99, escalateBelow: 0.8 });
    expect(typeof stages[0]!.latencyMs).toBe("number");
  });

  it.each([
    [0.8, "jev"],
    [0.7999, "llm"],
    [undefined, "llm"],
  ])("threshold edge: confidence %s with escalateBelow 0.8 is decided by %s", async (confidence, decidedBy) => {
    const out = await resolveJudge(
      UNDECIDED,
      judgeRequest(),
      chainDeps([[scriptedStage("jev", 0.8), scripted("jev", v("allow", confidence))], [builtinStage(), scripted("llm", v("ask"))]]),
    );
    expect(out).toMatchObject({ decidedBy });
  });

  it("a stage without a threshold is final on allow/deny whatever its confidence", async () => {
    const out = await resolveJudge(UNDECIDED, judgeRequest(), chainDeps([[scriptedStage("jev"), scripted("jev", v("deny", 0.1))], [builtinStage(), scripted("llm", v("allow"))]]));
    expect(out).toMatchObject({ decision: "deny", decidedBy: "jev" });
  });

  it("a low-confidence deny on the LAST stage goes to the user, not a silent deny or allow", async () => {
    const out = await resolveJudge(UNDECIDED, judgeRequest(), chainDeps([[scriptedStage("jev", 0.8), scripted("jev", v("allow", 0.5))]]));
    expect(out).toMatchObject({ decision: "ask", source: "judge" });
  });

  it("the last stage's ask goes to the dock; headless it is deny + defer", async () => {
    const stages = (): Array<[JudgeStageSettings, PermissionJudge]> => [
      [scriptedStage("jev", 0.8), scripted("jev", v("ask"))],
      [builtinStage(), scripted("llm", v("ask"))],
    ];
    expect(await resolveJudge(UNDECIDED, judgeRequest(), chainDeps(stages()))).toMatchObject({ decision: "ask" });
    expect(await resolveJudge(UNDECIDED, judgeRequest({ lane: "headless" }), chainDeps(stages()))).toMatchObject({ decision: "deny" });
  });
});

describe("judge chain — failures", () => {
  it("a mid-chain failure escalates and is recorded, never an allow by itself", async () => {
    const d = chainDeps([
      [scriptedStage("jev", 0.8), scripted("jev", new JudgeFailure("timeout", "slow"))],
      [builtinStage(), scripted("llm", v("allow"))],
    ]);
    const out = await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(out).toMatchObject({ decision: "allow", decidedBy: "llm", source: "judge" });
    expect(out.judged && out.fallback).toBeFalsy();
    const stages = judgeRecords(d)[0]!.stages as Array<Record<string, unknown>>;
    expect(stages[0]).toMatchObject({ id: "jev", outcome: "failed", fallback: "timeout", decision: null });
  });

  it("an unavailable stage (unconfigured model) escalates", async () => {
    const out = await resolveJudge(UNDECIDED, judgeRequest(), chainDeps([[builtinStage(), null], [scriptedStage("jev"), scripted("jev", v("deny"))]]));
    expect(out).toMatchObject({ decision: "deny", decidedBy: "jev" });
  });

  it.each([
    ["foreground", "ask"],
    ["headless", "deny"],
  ] as const)("last stage failing → existing fallback (%s: %s)", async (lane, decision) => {
    const out = await resolveJudge(
      UNDECIDED,
      judgeRequest({ lane }),
      chainDeps([
        [scriptedStage("jev", 0.8), scripted("jev", v("allow", 0.2))],
        [builtinStage(), scripted("llm", new Error("provider down"))],
      ]),
    );
    expect(out).toMatchObject({ judged: true, decision, source: "fallback", fallback: "error" });
    if (!out.judged) throw new Error("Expected a reviewed outcome");
    expect(Boolean(out.recentlyDenied)).toBe(lane === "headless");
  });

  it("every stage failing never allows", async () => {
    const out = await resolveJudge(
      UNDECIDED,
      judgeRequest(),
      chainDeps([
        [scriptedStage("jev"), scripted("jev", new JudgeFailure("unparseable", "garbage"))],
        [builtinStage(), null],
      ]),
    );
    expect(out).toMatchObject({ decision: "ask", source: "fallback", fallback: "unavailable" });
  });
});

describe("judge chain — audit model and deadline", () => {
  it("a stage without a model records the resolved reviewer model, not a placeholder", async () => {
    const reviewer = Object.assign(scripted("llm", v("allow")), { model: `claude/${PICKER_MODEL}` });
    const d = chainDeps([[{ provider: "builtin-llm", id: "llm" }, reviewer]]);
    await resolveJudge(UNDECIDED, judgeRequest(), d);
    const stage = (judgeRecords(d)[0]!.stages as Array<Record<string, unknown>>)[0]!;
    expect(stage.model).toBe(`claude/${PICKER_MODEL}`);
  });

  it("exceeding the chain deadline mid-chain is a failure: fallback applies and later stages never run", async () => {
    const slow = scripted("jev", v("ask"));
    slow.judge = () => new Promise<JudgeVerdict>(() => {});
    const llm = scripted("llm", v("allow"));
    const d = chainDeps([[scriptedStage("jev"), slow], [builtinStage(), llm]], { timeoutMs: 5_000, chainDeadlineMs: 40 });
    const out = await resolveJudge(UNDECIDED, judgeRequest({ lane: "headless" }), d);
    expect(out).toMatchObject({ judged: true, decision: "deny", source: "fallback", fallback: "timeout" });
    // The engine's own timer fired on the deadline-capped budget: the audit blames the deadline.
    expect(out.judged && out.rationale).toBe("Nobody can approve this request; do not retry.");
    expect(judgeRecords(d)[0]?.rationale).toMatch(/deadline/);
    expect(llm.calls).toBe(0);
    const stages = judgeRecords(d)[0]!.stages as Array<Record<string, unknown>>;
    expect(stages.map((s) => s.outcome)).toEqual(["failed", "skipped"]);
  });

  it("an ambiguous stage followed by a deadline overrun still falls back (never the earlier ask/allow)", async () => {
    const jev = scripted("jev", v("allow", 0.1));
    const slow = scripted("llm", v("allow"));
    slow.judge = () => new Promise<JudgeVerdict>(() => {});
    const d = chainDeps([[scriptedStage("jev", 0.8), jev], [builtinStage(), slow]], { timeoutMs: 5_000, chainDeadlineMs: 40 });
    const out = await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(out).toMatchObject({ decision: "ask", source: "fallback", fallback: "timeout" });
  });

  it("a provider-reported timeout under a deadline-capped stage budget is a stage failure, not the deadline: the next stage runs", async () => {
    // chainDeadlineMs < timeoutMs, so the first stage's budget is capped by the deadline.
    const jev = scripted("jev", new JudgeFailure("timeout", "jev backend timed out"));
    const llm = scripted("llm", v("deny"));
    const d = chainDeps([[scriptedStage("jev", 0.8), jev], [builtinStage(), llm]], { timeoutMs: 5_000, chainDeadlineMs: 2_000 });
    const out = await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(out).toMatchObject({ judged: true, decision: "deny", decidedBy: "llm", source: "judge" });
    expect(out.judged && out.fallback).toBeFalsy();
    expect(llm.calls).toBe(1);
    const record = judgeRecords(d)[0]!;
    expect(record.rationale).not.toMatch(/deadline/);
    expect((record.stages as Array<Record<string, unknown>>).map((s) => [s.id, s.outcome, s.fallback])).toEqual([
      ["jev", "failed", "timeout"],
      ["llm", "decided", null],
    ]);
  });
});

describe("judge chain — breaker and shadow", () => {
  it("denials from different stages share one per-session counter", async () => {
    const jev = scripted("jev", v("deny", 0.95), v("ask"), v("deny", 0.9));
    const llm = scripted("llm", v("deny"));
    const d = chainDeps([[scriptedStage("jev", 0.8), jev], [builtinStage(), llm]]);
    await resolveJudge(UNDECIDED, judgeRequest(), d); // jev deny
    await resolveJudge(UNDECIDED, judgeRequest(), d); // jev ask → llm deny
    expect(d.breaker.snapshot("session-root")).toMatchObject({ consecutive: 2, total: 2, open: false });
    expect(await resolveJudge(UNDECIDED, judgeRequest(), d)).toMatchObject({
      judged: true, source: "breaker", pause: "consecutive", decision: "ask", breakerTripped: true,
    });
    expect(d.breaker.isOpen("session-root")).toBe(true);
    expect(await resolveJudge(UNDECIDED, judgeRequest(), d)).toMatchObject({
      judged: true, source: "breaker", pause: "consecutive", decision: "ask", breakerTripped: false,
    });
    expect(jev.calls + llm.calls).toBe(4);
  });

  it("escalated (non-final) denials and stage failures do not count", async () => {
    const d = chainDeps([
      [scriptedStage("jev", 0.8), scripted("jev", v("deny", 0.1))],
      [builtinStage(), scripted("llm", new Error("down"))],
    ]);
    for (let i = 0; i < 4; i++) await resolveJudge(UNDECIDED, judgeRequest(), d);
    expect(d.breaker.snapshot("session-root").total).toBe(0);
  });

  it("shadow runs the whole chain and applies nothing", async () => {
    const jev = scripted("jev", v("ask"));
    const llm = scripted("llm", v("deny"));
    const d = chainDeps([[scriptedStage("jev"), jev], [builtinStage(), llm]], { mode: "shadow" });
    const out = await resolveJudge(UNDECIDED, judgeRequest({ lane: "headless" }), d);
    expect(out).toMatchObject({ decision: "deny", applied: false });
    expect(jev.calls + llm.calls).toBe(2);
    expect(d.chained).toHaveLength(0);
    expect((judgeRecords(d)[0]!.stages as unknown[]).length).toBe(2);
    expect(d.breaker.snapshot("session-root").total).toBe(0);
  });
});
