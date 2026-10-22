/**
 * Judge circuit breaker. Per root session: N consecutive or M total judge
 * DENIALS pause automation for that session, which returns every later call
 * to normal prompting. Timeouts and other fallbacks are not denials and do not
 * count. An allow resets the consecutive streak only.
 *
 * Subagents share their parent's counter: the caller keys by the root session.
 */
import type { JudgeBreakerSettings } from "./judge-settings.js";

interface SessionCounters {
  consecutive: number;
  total: number;
  open: boolean;
}

export class JudgeCircuitBreaker {
  private readonly sessions = new Map<string, SessionCounters>();

  constructor(private limits: JudgeBreakerSettings) {}

  setLimits(limits: JudgeBreakerSettings): void {
    this.limits = { ...limits };
    for (const counters of this.sessions.values()) {
      if (counters.consecutive >= limits.consecutive || counters.total >= limits.total) counters.open = true;
    }
  }

  private counters(sessionId: string): SessionCounters {
    let c = this.sessions.get(sessionId);
    if (!c) {
      c = { consecutive: 0, total: 0, open: false };
      this.sessions.set(sessionId, c);
    }
    return c;
  }

  isOpen(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.open ?? false;
  }

  /** Record one judge decision. Returns true when this record tripped the breaker. */
  record(sessionId: string, decision: "allow" | "ask" | "deny"): boolean {
    const c = this.counters(sessionId);
    if (decision === "allow") {
      c.consecutive = 0;
      return false;
    }
    if (decision === "ask") return false;
    c.consecutive += 1;
    c.total += 1;
    if (!c.open && (c.consecutive >= this.limits.consecutive || c.total >= this.limits.total)) {
      c.open = true;
      return true;
    }
    return false;
  }

  snapshot(sessionId: string): { consecutive: number; total: number; open: boolean } {
    const c = this.sessions.get(sessionId);
    return c ? { ...c } : { consecutive: 0, total: 0, open: false };
  }

  /** Drop a session's counters when the conversation ends. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
