import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JudgeCircuitBreaker, JUDGE_BLOCK_THRESHOLDS } from "../judge-breaker.js";
import { JudgeContractError } from "../judge-contract.js";

function breaker() { return new JudgeCircuitBreaker(JUDGE_BLOCK_THRESHOLDS); }

describe("reviewer turn block counters", () => {
  it("counts a blocked invocation once across repeated reviews", () => {
    const subject = breaker();
    subject.record("session", "ask", "one");
    subject.record("session", "deny", "one");
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 1, open: false });
  });

  it.each(["ask", "deny"] as const)("pauses after three consecutive %s decisions", (decision) => {
    const subject = breaker();
    expect(subject.record("session", decision, randomUUID())).toBe(false);
    expect(subject.record("session", decision, randomUUID())).toBe(false);
    expect(subject.record("session", decision, randomUUID())).toBe(true);
    expect(subject.pauseReason("session")).toBe("consecutive");
    expect(subject.snapshot("session")).toEqual({ consecutive: 3, total: 3, open: true });
    subject.record("session", "allow", randomUUID());
    subject.setLimits(JUDGE_BLOCK_THRESHOLDS);
    expect(subject.isOpen("session")).toBe(true);
  });

  it("pauses after twenty separated denials in one turn", () => {
    const subject = breaker();
    for (let i = 0; i < 19; i += 1) {
      expect(subject.record("session", "deny", randomUUID())).toBe(false);
      subject.record("session", "allow", randomUUID());
    }
    expect(subject.record("session", "ask", randomUUID())).toBe(true);
    expect(subject.pauseReason("session")).toBe("total");
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 20, open: true });
  });

  it("resets every counter and invocation identity only at a new turn", () => {
    const subject = breaker();
    for (let i = 0; i < 3; i += 1) subject.record("session", "deny", `blocked-${i}`);
    subject.beginTurn("session");
    expect(subject.snapshot("session")).toEqual({ consecutive: 0, total: 0, open: false });
    subject.record("session", "deny", "blocked-0");
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 1, open: false });
  });

  it("does not replay an old allow to reset a later block", () => {
    const subject = breaker();
    subject.record("session", "allow", "old");
    subject.record("session", "deny", "new");
    subject.record("session", "allow", "old");
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 1, open: false });
  });

  it("keeps turns independent and releases counters at session end", () => {
    const subject = breaker();
    for (let i = 0; i < 3; i += 1) subject.record("one", "deny", randomUUID());
    expect(subject.isOpen("two")).toBe(false);
    subject.forget("one");
    expect(subject.isOpen("one")).toBe(false);
  });

  it.each([undefined, "", "   "])("rejects missing invocation identity %j", (identity) => {
    expect(() => breaker().record("session", "deny", identity as never)).toThrow(JudgeContractError);
  });

  it.each([{ consecutive: 2, total: 20 }, { consecutive: 3, total: 21 }])("rejects noncanonical limits %j", (limits) => {
    expect(() => breaker().setLimits(limits)).toThrow(JudgeContractError);
  });
});
