// Count successful classifier blocks per root session. Failures and host safety refusals never enter this counter.
import { JudgeContractError } from "./judge-contract.js";
import type { JudgeBreakerSettings } from "./judge-settings.js";

export const JUDGE_BLOCK_THRESHOLDS: Readonly<JudgeBreakerSettings> = Object.freeze({ consecutive: 3, total: 20 });

type PauseReason = "consecutive" | "total";

interface SessionCounters {
  consecutive: number;
  total: number;
  pauseReason?: PauseReason;
  blockedInvocations: Set<string>;
  allowedInvocations: Set<string>;
}

export class JudgeCircuitBreaker {
  private readonly sessions = new Map<string, SessionCounters>();

  constructor(limits: JudgeBreakerSettings) {
    this.setLimits(limits);
  }

  // Rewiring cannot change the fixed thresholds or clear a paused session.
  setLimits(limits: JudgeBreakerSettings): void {
    if (limits.consecutive !== JUDGE_BLOCK_THRESHOLDS.consecutive || limits.total !== JUDGE_BLOCK_THRESHOLDS.total) {
      throw new JudgeContractError("Judge block thresholds must be 3 consecutive or 20 total");
    }
  }

  private counters(sessionId: string): SessionCounters {
    let c = this.sessions.get(sessionId);
    if (!c) {
      c = { consecutive: 0, total: 0, blockedInvocations: new Set(), allowedInvocations: new Set() };
      this.sessions.set(sessionId, c);
    }
    return c;
  }

  isOpen(sessionId: string): boolean {
    return this.pauseReason(sessionId) !== undefined;
  }

  pauseReason(sessionId: string): PauseReason | undefined {
    return this.sessions.get(sessionId)?.pauseReason;
  }

  // Internal scope assessments and cache replays retain the invocation identity.
  // A successful block counts once, even if another assessment sees it again.
  record(sessionId: string, decision: "allow" | "ask" | "deny", invocationId: string): boolean {
    if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
      throw new JudgeContractError("Judge block counter requires allow, ask or deny");
    }
    if (typeof invocationId !== "string" || invocationId.trim().length === 0) {
      throw new JudgeContractError("Judge block counter requires an invocation id");
    }
    const c = this.counters(sessionId);
    if (c.pauseReason !== undefined) return false;
    if (decision === "allow") {
      if (c.allowedInvocations.has(invocationId)) return false;
      c.allowedInvocations.add(invocationId);
      c.consecutive = 0;
      return false;
    }
    if (c.blockedInvocations.has(invocationId)) return false;
    c.blockedInvocations.add(invocationId);
    c.consecutive += 1;
    c.total += 1;
    // The session total is consumed only when its own limit causes fallback.
    if (c.total >= JUDGE_BLOCK_THRESHOLDS.total) {
      c.total = 0;
      c.pauseReason = "total";
      return true;
    }
    if (c.consecutive >= JUDGE_BLOCK_THRESHOLDS.consecutive) {
      c.pauseReason = "consecutive";
      return true;
    }
    return false;
  }

  snapshot(sessionId: string): { consecutive: number; total: number; open: boolean } {
    const c = this.sessions.get(sessionId);
    return c
      ? { consecutive: c.consecutive, total: c.total, open: c.pauseReason !== undefined }
      : { consecutive: 0, total: 0, open: false };
  }

  // Only the host's authenticated manual-approval path may call this after an allowed action.
  resume(sessionId: string): void {
    const c = this.sessions.get(sessionId);
    if (!c) return;
    c.consecutive = 0;
    delete c.pauseReason;
  }

  // Drop a session's counters when the conversation ends.
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
