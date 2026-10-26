import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JudgeCircuitBreaker, JUDGE_BLOCK_THRESHOLDS } from "../judge-breaker.js";
import { JudgeContractError } from "../judge-contract.js";

function breaker() {
  return new JudgeCircuitBreaker(JUDGE_BLOCK_THRESHOLDS);
}

describe("judge classifier block counters", () => {
  it("counts a blocked invocation once across scope review, ordinary review and cache replay", () => {
    const subject = breaker();
    expect(subject.record("session", "ask", "invocation-one")).toBe(false);
    expect(subject.record("session", "deny", "invocation-one")).toBe(false);
    expect(subject.record("session", "ask", "invocation-one")).toBe(false);
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 1, open: false });
    expect(subject.record("session", "deny", "invocation-two")).toBe(false);
    expect(subject.snapshot("session")).toEqual({ consecutive: 2, total: 2, open: false });
    expect(subject.record("session", "ask", "invocation-three")).toBe(true);
  });

  it("does not replay an old allow to reset a newer invocation's block", () => {
    const subject = breaker();
    subject.record("session", "allow", "allowed-invocation");
    subject.record("session", "deny", "blocked-invocation");
    subject.record("session", "allow", "allowed-invocation");
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 1, open: false });
  });

  it("records a block once when an earlier assessment allowed the same invocation", () => {
    const subject = breaker();
    subject.record("session", "allow", "invocation-one");
    subject.record("session", "deny", "invocation-one");
    subject.record("session", "deny", "invocation-one");
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 1, open: false });
  });

  it("retains counted identities across resume and clears them only at session end", () => {
    const subject = breaker();
    subject.record("session", "deny", "invocation-one");
    subject.resume("session");
    subject.record("session", "deny", "invocation-one");
    expect(subject.snapshot("session")).toEqual({ consecutive: 0, total: 1, open: false });
    subject.forget("session");
    subject.record("session", "deny", "invocation-one");
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 1, open: false });
  });

  it.each([undefined, "", "   "])("rejects a missing invocation identity %j", (invocationId) => {
    expect(() => breaker().record("session", "deny", invocationId as never)).toThrow("requires an invocation id");
  });

  it.each(["ask", "deny"] as const)("pauses after three consecutive %s decisions", (decision) => {
    const subject = breaker();
    expect(subject.record("session", decision, randomUUID())).toBe(false);
    expect(subject.record("session", decision, randomUUID())).toBe(false);
    expect(subject.snapshot("session")).toEqual({ consecutive: 2, total: 2, open: false });
    expect(subject.record("session", decision, randomUUID())).toBe(true);
    expect(subject.pauseReason("session")).toBe("consecutive");
    expect(subject.snapshot("session")).toEqual({ consecutive: 3, total: 3, open: true });
  });

  it("an allowed action clears the consecutive count and preserves the session total", () => {
    const subject = breaker();
    subject.record("session", "deny", randomUUID());
    subject.record("session", "ask", randomUUID());
    subject.record("session", "allow", randomUUID());
    expect(subject.snapshot("session")).toEqual({ consecutive: 0, total: 2, open: false });
    expect(subject.record("session", "deny", randomUUID())).toBe(false);
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 3, open: false });
  });

  it("twenty separated blocks pause and reset only the total counter", () => {
    const subject = breaker();
    for (let block = 1; block < 20; block += 1) {
      expect(subject.record("session", "deny", randomUUID())).toBe(false);
      subject.record("session", "allow", randomUUID());
    }
    expect(subject.snapshot("session")).toEqual({ consecutive: 0, total: 19, open: false });
    expect(subject.record("session", "ask", randomUUID())).toBe(true);
    expect(subject.pauseReason("session")).toBe("total");
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 0, open: true });
    subject.resume("session");
    expect(subject.snapshot("session")).toEqual({ consecutive: 0, total: 0, open: false });
  });

  it("manual approval resumes after consecutive fallback without clearing the total", () => {
    const subject = breaker();
    for (let block = 0; block < 3; block += 1) subject.record("session", "deny", randomUUID());
    subject.resume("session");
    expect(subject.pauseReason("session")).toBeUndefined();
    expect(subject.snapshot("session")).toEqual({ consecutive: 0, total: 3, open: false });
    expect(subject.record("session", "ask", randomUUID())).toBe(false);
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 4, open: false });
  });

  it("repeated consecutive fallbacks preserve blocks until the total limit itself triggers", () => {
    const subject = breaker();
    for (let block = 1; block <= 19; block += 1) {
      const tripped = subject.record("session", "deny", randomUUID());
      if (tripped) {
        expect(subject.pauseReason("session")).toBe("consecutive");
        subject.resume("session");
      }
    }
    expect(subject.snapshot("session")).toEqual({ consecutive: 1, total: 19, open: false });
    expect(subject.record("session", "deny", randomUUID())).toBe(true);
    expect(subject.pauseReason("session")).toBe("total");
    expect(subject.snapshot("session")).toEqual({ consecutive: 2, total: 0, open: true });
  });

  it("a paused session stays frozen until manual approval, including during rewiring", () => {
    const subject = breaker();
    for (let block = 0; block < 3; block += 1) subject.record("session", "deny", randomUUID());
    expect(subject.record("session", "deny", randomUUID())).toBe(false);
    expect(subject.record("session", "allow", randomUUID())).toBe(false);
    subject.setLimits({ consecutive: 3, total: 20 });
    expect(subject.snapshot("session")).toEqual({ consecutive: 3, total: 3, open: true });
  });

  it("keeps sessions independent and forgets counters at session end", () => {
    const subject = breaker();
    for (let block = 0; block < 3; block += 1) subject.record("parent", "deny", randomUUID());
    expect(subject.isOpen("parent")).toBe(true);
    expect(subject.snapshot("other")).toEqual({ consecutive: 0, total: 0, open: false });
    subject.forget("parent");
    expect(subject.isOpen("parent")).toBe(false);
    expect(subject.snapshot("parent")).toEqual({ consecutive: 0, total: 0, open: false });
    subject.resume("absent");
    expect(subject.snapshot("absent")).toEqual({ consecutive: 0, total: 0, open: false });
  });

  it("manual approval counts as an allowed action before a pause too", () => {
    const subject = breaker();
    subject.record("session", "deny", randomUUID());
    subject.resume("session");
    expect(subject.snapshot("session")).toEqual({ consecutive: 0, total: 1, open: false });
  });

  it.each([
    { consecutive: 2, total: 20 },
    { consecutive: 3, total: 21 },
    { consecutive: Number.NaN, total: 20 },
  ])("rejects noncanonical block thresholds %j", (limits) => {
    expect(() => new JudgeCircuitBreaker(limits)).toThrow(JudgeContractError);
    expect(() => breaker().setLimits(limits)).toThrow("3 consecutive or 20 total");
  });

  it("rejects malformed decisions even while automation is paused", () => {
    const subject = breaker();
    for (let block = 0; block < 3; block += 1) subject.record("session", "deny", randomUUID());
    expect(() => subject.record("session", "invalid" as never, randomUUID())).toThrow(JudgeContractError);
  });
});
