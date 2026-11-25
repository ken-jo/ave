// Template-run membership (permission tree: run-scoped grant, per-stage breaker). Host-minted and memory only: which sessions a template
// run's engine linked, the stage each works for, and whether the run's "Allow for this run" grants apply to it. Only the run engine's
// hooks write here. A run that ended takes no member again, so a grant keyed by its run can never be read after it.

/** How the run started. A schedule-started run's stage sessions are members for their breaker only: they never read or make a run grant. */
type RunSessionLane = "attended" | "unattended";

export interface RunSessionMember {
  readonly runKey: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly lane: RunSessionLane;
}

export class RunGrantError extends Error {
  constructor(readonly code: "invalid-member" | "session-in-another-run" | "run-ended" | "not-a-run-member" | "invalid-ancestry", message: string) {
    super(message);
    this.name = "RunGrantError";
  }
}

const members = new Map<string, RunSessionMember>();
const sessionsByRun = new Map<string, Set<string>>();
const endedRuns = new Set<string>();

/**
 * Links a session to its run. Returns false when the same link already exists. Throws when the member is malformed, the session belongs
 * to another run or stage, or the run has ended.
 */
export function registerRunSession(runKey: string, sessionId: string, member: { stageId: string; stageName: string; lane: RunSessionLane }): boolean {
  if (runKey.length === 0 || sessionId.length === 0 || member.stageId.length === 0 || member.stageName.length === 0
    || (member.lane !== "attended" && member.lane !== "unattended")) {
    throw new RunGrantError("invalid-member", "A run session needs its run, its session, its stage and its lane");
  }
  if (endedRuns.has(runKey)) throw new RunGrantError("run-ended", "The run has ended and takes no session");
  const known = members.get(sessionId);
  if (known !== undefined) {
    if (known.runKey !== runKey || known.stageId !== member.stageId || known.lane !== member.lane) {
      throw new RunGrantError("session-in-another-run", "The session already belongs to another run or stage");
    }
    return false;
  }
  members.set(sessionId, Object.freeze({ runKey, stageId: member.stageId, stageName: member.stageName, lane: member.lane }));
  const sessions = sessionsByRun.get(runKey) ?? new Set<string>();
  sessions.add(sessionId);
  sessionsByRun.set(runKey, sessions);
  return true;
}

// A session's parent, by the host's spawn record. Set once at boot; until then, and for a session the record does not know, a session
// has no parent and only a linked stage session is a run member.
let parentOf: (sessionId: string) => string | undefined = () => undefined;
export function setRunSessionParentResolver(resolve: (sessionId: string) => string | undefined): void {
  parentOf = resolve;
}

/**
 * The run membership a session works under, whatever its lane: its own when the run linked it (a stage session), else that of its
 * nearest ancestor a run linked (a stage session's sub-agent shares the stage's run grants and shows its stage). A stage that ended
 * leaves its descendants no membership.
 */
export function runSessionOf(sessionId: string | undefined): RunSessionMember | undefined {
  // With no run open no session is a member, and no spawn record is read.
  if (sessionId === undefined || members.size === 0) return undefined;
  const seen = new Set<string>();
  for (let current: string | undefined = sessionId; current !== undefined; current = parentOf(current)) {
    const member = members.get(current);
    if (member !== undefined) return member;
    if (seen.has(current)) throw new RunGrantError("invalid-ancestry", "Session ancestry contains a cycle");
    seen.add(current);
  }
  return undefined;
}

/** True for a session a run linked itself (a stage session), not for its descendants. */
export function isRunStageSession(sessionId: string): boolean {
  return members.has(sessionId);
}

/** The run whose grants this session reads and makes: an attended run it is a live member of. Undefined for every other session. */
export function runGrantKeyOfSession(sessionId: string | undefined): string | undefined {
  const member = runSessionOf(sessionId);
  return member?.lane === "attended" ? member.runKey : undefined;
}

/** The session's run for a new grant; throws for a session that may make none. */
export function requireRunGrantKey(sessionId: string | undefined): string {
  const runKey = runGrantKeyOfSession(sessionId);
  if (runKey === undefined) throw new RunGrantError("not-a-run-member", "Only a session of a live attended run can allow for the run");
  return runKey;
}

/** The session left its run; the run and its grants stay for the other stage sessions. */
export function endRunSession(sessionId: string): void {
  const member = members.get(sessionId);
  if (member === undefined) return;
  members.delete(sessionId);
  const sessions = sessionsByRun.get(member.runKey);
  sessions?.delete(sessionId);
  if (sessions?.size === 0) sessionsByRun.delete(member.runKey);
}

/** The run is over: its members go and it takes none again. Returns the sessions that were still linked. */
export function endRun(runKey: string): readonly string[] {
  if (runKey.length === 0) throw new RunGrantError("invalid-member", "A run end names its run");
  endedRuns.add(runKey);
  const sessions = [...(sessionsByRun.get(runKey) ?? [])];
  for (const sessionId of sessions) members.delete(sessionId);
  sessionsByRun.delete(runKey);
  return sessions;
}

export function __resetRunGrantsForTest(): void {
  parentOf = () => undefined;
  members.clear();
  sessionsByRun.clear();
  endedRuns.clear();
}
