import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseClaudeCodePlanUsage, parseCodexPlanUsage, parseGrokBuildPlanUsage } from "../subscription-plan-usage-parsers.js";
import { ClaudeCodeStream } from "../claude-code-stream.js";

// Sanitized wire examples retain the account RPC shape and the documented stream event fields.
const records = JSON.parse(readFileSync(new URL("./fixtures/subscription-plan-usage-events.json", import.meta.url), "utf8"));

describe("reported subscription quota projection", () => {
  it("distinguishes explicit slot withdrawals from omitted snapshot fields", () => {
    expect(parseCodexPlanUsage({ rateLimits: { primary: null } })).toEqual([{ id: "codex:primary", removed: true }]);
    expect(parseCodexPlanUsage({ rateLimits: { secondary: null } })).toEqual([{ id: "codex:secondary", removed: true }]);
    expect(parseCodexPlanUsage({ rateLimits: { primary: { usedPercent: 10 } } }))
      .toEqual([{ id: "codex:primary", usedPercent: 10 }]);
    expect(parseCodexPlanUsage({ rateLimitsByLimitId: { "invalid id": { secondary: null } } })).toEqual([]);
  });
  it("replays account quota buckets without duplicating the compatibility bucket", () => {
    expect(parseCodexPlanUsage(records.accountRead)).toEqual([
      { id: "codex:primary", usedPercent: 25, resetsAt: 1730947200000, windowDurationMins: 15 },
      { id: "codex:secondary", removed: true },
      { id: "codex_other:primary", usedPercent: 42, resetsAt: 1730950800000, windowDurationMins: 60 },
      { id: "codex_other:secondary", removed: true },
    ]);
    expect(parseCodexPlanUsage(records.accountUpdated.params)).toEqual([
      { id: "codex:primary", usedPercent: 31, resetsAt: 1730948100000, windowDurationMins: 15 },
    ]);
  });

  it("keeps a reported zero and partial gauges without inventing missing fields", () => {
    expect(parseCodexPlanUsage({ rateLimits: { primary: { usedPercent: 0 }, secondary: { resetsAt: 1730947200 } } }))
      .toEqual([{ id: "codex:primary", usedPercent: 0 }, { id: "codex:secondary", resetsAt: 1730947200000 }]);
    expect(parseClaudeCodePlanUsage(records.rateLimitAllowed)).toEqual([
      { id: "seven_day", resetsAt: 1730950800000 },
    ]);
    expect(parseClaudeCodePlanUsage({ rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } }))
      .toEqual([]);
  });

  it("converts a reported utilization fraction without forwarding metadata", () => {
    expect(parseClaudeCodePlanUsage(records.rateLimitEvent)).toEqual([
      { id: "five_hour", usedPercent: 85, resetsAt: 1730947200000 },
    ]);
    expect(parseClaudeCodePlanUsage({ rate_limit_info: {
      rateLimitType: "seven_day_sonnet", utilization: 0, overageStatus: "allowed", secret: "do not forward",
    } })).toEqual([{ id: "seven_day_sonnet", usedPercent: 0 }]);
  });

  it.each([NaN, Infinity, -1, 101, "42"])("rejects invalid account percentages %s", (usedPercent) => {
    expect(parseCodexPlanUsage({ rateLimits: { primary: { usedPercent, resetsAt: 1730947200 } } })).toEqual([]);
  });

  it.each([NaN, Infinity, -0.1, 1.01, "0.5"])("rejects invalid utilization fractions %s", (utilization) => {
    expect(parseClaudeCodePlanUsage({ rate_limit_info: { rateLimitType: "five_hour", utilization } })).toEqual([]);
  });

  it("drops malformed timestamps, empty windows and unsafe bucket identifiers", () => {
    expect(parseCodexPlanUsage({ rateLimitsByLimitId: {
      "account@example.com": { primary: { usedPercent: 40 } },
      valid: { primary: { usedPercent: 40, resetsAt: -1 }, secondary: {} },
    } })).toEqual([]);
    expect(parseClaudeCodePlanUsage({ rate_limit_info: { rateLimitType: "unknown", utilization: 0.5 } })).toEqual([]);
    expect(parseCodexPlanUsage(null)).toEqual([]);
  });

  it("bounds the number of projected windows", () => {
    const buckets = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`bucket_${i}`, {
      primary: { usedPercent: i }, secondary: { usedPercent: i },
    }]));
    expect(parseCodexPlanUsage({ rateLimitsByLimitId: buckets })).toHaveLength(32);
  });

  it("projects period billing gauges and never derives usage from monetary amounts", () => {
    expect(parseGrokBuildPlanUsage({ config: { creditUsagePercent: 32.5,
      currentPeriod: { type: "monthly", start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" } } }))
      .toEqual([{ id: "current-period", usedPercent: 32.5, resetsAt: Date.parse("2026-11-01T00:00:00Z") }]);
    expect(parseGrokBuildPlanUsage({ config: { creditUsagePercent: 0 } })).toEqual([{ id: "current-period", usedPercent: 0 }]);
    expect(parseGrokBuildPlanUsage({ config: { monthlySpend: 40, monthlyLimit: 100 } })).toEqual([]);
    expect(parseGrokBuildPlanUsage({ config: { currentPeriod: { end: "next month" } } })).toEqual([]);
    expect(parseGrokBuildPlanUsage({ config: { currentPeriod: { end: "2026-02-30T00:00:00Z" } } })).toEqual([]);
    expect(parseGrokBuildPlanUsage({ config: { creditUsagePercent: 150 } })).toEqual([]);
  });

  it("replays stream quota records only after the existing invocation identity check", () => {
    const onPlanUsage = vi.fn();
    const stream = new ClaudeCodeStream([], onPlanUsage);
    expect(() => stream.accept(records.rateLimitEvent)).toThrow("claude-code-operation-failed");
    stream.accept({ type: "system", subtype: "init", session_id: records.rateLimitEvent.session_id,
      tools: [], mcp_servers: [], plugins: [] });
    expect(() => stream.accept({ ...records.rateLimitEvent, session_id: "foreign" })).toThrow();
    expect(onPlanUsage).not.toHaveBeenCalled();
    expect(stream.accept(records.rateLimitEvent)).toEqual([]);
    expect(onPlanUsage).toHaveBeenLastCalledWith([{ id: "five_hour", usedPercent: 85, resetsAt: 1730947200000 }]);
    expect(stream.accept(records.rateLimitAllowed)).toEqual([]);
    expect(onPlanUsage).toHaveBeenLastCalledWith([{ id: "seven_day", resetsAt: 1730950800000 }]);
    expect(() => stream.accept({ ...records.rateLimitEvent, rate_limit_info: "malformed" })).not.toThrow();
  });
});
