import { randomUUID } from "node:crypto";
import {
  TERMINAL_OBSERVATION_LIMITS,
  type ObservationIdentity,
  type TerminalObservedCommand,
  type TerminalObservationDecision,
  type TerminalObservationEvent,
} from "../shared/agent-observation.js";
import { isPiiRedactionEnabled, maskSensitiveData, scrubDiagnosticSecretsStrict } from "../shared/dlp.js";
import type { AgentTerminalEgressDecision, AgentTerminalObservationInput, AgentTerminalObservationLease } from "../tools/agent-terminal-observation.js";
import { createMaskedProgressRelay } from "../tools/tool-output-progress.js";
import { ObservationDaemon, type ObservationAdapter } from "./daemon.js";

function redact(text: string, limit: number): string {
  return maskSensitiveData(scrubDiagnosticSecretsStrict(text), { pii: isPiiRedactionEnabled() }).masked.slice(0, limit);
}

interface CommandOwner {
  command: TerminalObservedCommand;
  close(): void;
}
interface TerminalSession {
  commands: Map<string, CommandOwner>;
  views: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}
interface TerminalView {
  sessionId: string;
  isCurrent(): boolean;
}

/** Streaming control framing removes terminal escape carriers before shared credential masking. */
function createOutputFramer(deliver: (text: string) => void) {
  let state: "text" | "escape" | "csi" | "string" | "string-escape" = "text";
  let osc = false;
  let line = "";
  let carriageReturn = false;
  const flush = (suffix = ""): void => {
    if (line || suffix) deliver(line + suffix);
    line = "";
    carriageReturn = false;
  };
  const write = (text: string): void => {
    for (const character of text) {
      if (state !== "string" && state !== "string-escape") {
        if (character === "\x1b") { state = "escape"; continue; }
        if (character === "\x9b") { state = "csi"; continue; }
        if (character === "\x9d" || character === "\x90" || character === "\x98" || character === "\x9e" || character === "\x9f") {
          osc = character === "\x9d";
          state = "string";
          continue;
        }
        if (character === "\x9c") { state = "text"; continue; }
      }
      if (state === "escape") {
        osc = character === "]";
        state = character === "[" ? "csi" : osc || character === "P" || character === "X" || character === "^" || character === "_" ? "string" : "text";
      } else if (state === "csi") {
        if (character >= "@" && character <= "~") state = "text";
      } else if (state === "string") {
        if (character === "\x9c" || osc && character === "\x07") state = "text";
        else if (character === "\x1b") state = "string-escape";
      } else if (state === "string-escape") {
        state = character === "\\" || character === "\x9c" || osc && character === "\x07" ? "text"
          : character === "\x1b" ? "string-escape" : "string";
      } else if (character === "\n") flush("\n");
      else if (character === "\r") carriageReturn = true;
      else if (character === "\b") line = line.slice(0, -1);
      else if (character === "\t" || character >= " " && !/[\x7f-\x9f]/.test(character)) {
        if (carriageReturn) { line = ""; carriageReturn = false; }
        line += character;
        if (line.length >= TERMINAL_OBSERVATION_LIMITS.maxPendingChars / 2) flush();
      }
    }
  };
  return { write, end: () => flush(), dispose: () => { line = ""; state = "text"; carriageReturn = false; } };
}

/** One source on the existing daemon; command history is local, redacted and bounded. */
export class TerminalObservationAdapter implements ObservationAdapter {
  readonly source = "terminal" as const;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly views = new Map<string, TerminalView>();
  private readonly egress = new Map<string, { owner: CommandOwner; sessionId: string; attribution: TerminalObservationDecision["attribution"] }>();
  private disposed = false;

  constructor(private readonly daemon: ObservationDaemon) { daemon.registerAdapter(this); }

  private session(sessionId: string): TerminalSession {
    if (this.disposed) throw new Error("Terminal observation is disposed.");
    if (!sessionId || sessionId.length > 256) throw new Error("Invalid terminal observation session.");
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return existing;
    }
    if (this.sessions.size >= TERMINAL_OBSERVATION_LIMITS.maxSessions) {
      const idle = [...this.sessions].find(([, value]) => value.views.size === 0
        && [...value.commands.values()].every(({ command }) => command.status !== "running"));
      if (!idle) throw new Error("Terminal observation session limit exceeded.");
      this.releaseSession(idle[0]);
    }
    const session: TerminalSession = { commands: new Map(), views: new Set() };
    this.sessions.set(sessionId, session);
    return session;
  }

  start(identity: ObservationIdentity, input: AgentTerminalObservationInput): AgentTerminalObservationLease {
    if (!identity.turnId || identity.turnId.length > 256 || !identity.toolUseId || identity.toolUseId.length > 256
      || !input.command || !input.cwd || !["isolated", "unconfined", "disposable"].includes(input.sandbox.mode)
      || input.kind !== "shell" && input.kind !== "terminal"
      || input.kind === "terminal" && (!input.tabId || !input.terminalSessionId)
      || input.outputAvailability !== undefined && !["streaming", "on-completion", "withheld-user-input"].includes(input.outputAvailability)
      || input.outputAvailability === "withheld-user-input" && input.kind !== "terminal"
      || input.outputHeld !== undefined && (input.outputHeld !== true || input.kind !== "shell" || input.outputAvailability !== "on-completion")) {
      throw new Error("Invalid terminal observation command.");
    }
    const session = this.session(identity.sessionId);
    if (session.commands.size >= TERMINAL_OBSERVATION_LIMITS.maxCommands) {
      const completed = [...session.commands].find(([, value]) => value.command.status !== "running");
      if (!completed) throw new Error("Terminal observation command limit exceeded.");
      session.commands.delete(completed[0]);
    }
    const command: TerminalObservedCommand = {
      id: randomUUID(), toolUseId: redact(identity.toolUseId, 256), turnId: redact(identity.turnId, 256),
      kind: input.kind, command: redact(input.command, TERMINAL_OBSERVATION_LIMITS.maxCommandChars),
      cwd: redact(input.cwd, TERMINAL_OBSERVATION_LIMITS.maxCwdChars),
      ...(input.tabId ? { tabId: redact(input.tabId, 256) } : {}),
      ...(input.terminalSessionId ? { terminalSessionId: redact(input.terminalSessionId, 256) } : {}),
      startedAt: Date.now(), finishedAt: null, durationMs: 0, status: "running", exitCode: null,
      outputTail: "", outputTruncated: false,
      sandbox: { mode: input.sandbox.mode, detail: redact(input.sandbox.detail, 256) },
      outputAvailability: input.outputAvailability ?? "streaming", decisions: [],
    };
    let closed = false;
    const controller = new AbortController();
    const active = (): boolean => !closed && !this.disposed && this.sessions.get(identity.sessionId) === session
      && session.commands.get(command.id) === owner;
    // Held output (a checked command whose result is released only after revalidation) is masked and bounded as usual but stays out of every
    // snapshot until releaseHeldOutput.
    let held: { tail: string; truncated: boolean } | undefined = input.outputHeld ? { tail: "", truncated: false } : undefined;
    const append = (text: string): void => {
      if (!active()) return;
      const target = held ?? { tail: command.outputTail, truncated: command.outputTruncated };
      const combined = target.tail + text;
      target.truncated ||= combined.length > TERMINAL_OBSERVATION_LIMITS.maxOutputChars || text.includes("[REDACTED:OUTPUT_LIMIT]");
      target.tail = combined.slice(-TERMINAL_OBSERVATION_LIMITS.maxOutputChars);
      if (held) return;
      command.outputTail = target.tail;
      command.outputTruncated = target.truncated;
      this.changed(identity.sessionId);
    };
    const relay = createMaskedProgressRelay(append, (text) => redact(text, Number.MAX_SAFE_INTEGER),
      { maxHeldChars: TERMINAL_OBSERVATION_LIMITS.maxPendingChars / 2 });
    const framer = createOutputFramer((text) => relay.write(text));
    const unbind = (): void => {
      for (const [token, binding] of this.egress) if (binding.owner === owner) this.egress.delete(token);
    };
    const finish = (exitCode: number | null, status: Exclude<TerminalObservedCommand["status"], "running"> = exitCode === 0 ? "completed" : "failed"): void => {
      if (!active()) return;
      if (exitCode !== null && !Number.isSafeInteger(exitCode)) throw new Error("Invalid observed terminal exit code.");
      framer.end();
      relay.end();
      closed = true;
      unbind();
      command.exitCode = exitCode;
      command.status = status;
      command.finishedAt = Date.now();
      command.durationMs = Math.max(0, command.finishedAt - command.startedAt);
      controller.abort();
      this.changed(identity.sessionId);
    };
    const owner: CommandOwner = { command, close: () => { closed = true; framer.dispose(); relay.end(); unbind(); controller.abort(); } };
    session.commands.set(command.id, owner);
    this.changed(identity.sessionId);
    return {
      signal: controller.signal,
      write: (text, options) => {
        if (command.outputAvailability === "withheld-user-input") throw new Error("Terminal observation output is withheld for this command.");
        if (!active()) return;
        if (options?.truncated) {
          if (held) held.truncated = true;
          else { command.outputTruncated = true; this.changed(identity.sessionId); }
        }
        framer.write(text);
      },
      finish,
      bindEgress: (token, attribution = "command") => {
        if (command.outputAvailability === "withheld-user-input") throw new Error("Terminal observation egress is withheld for this command.");
        if (!active()) return;
        if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("Invalid terminal observation egress binding.");
        const existing = this.egress.get(token);
        if (existing && existing.owner !== owner) throw new Error("Terminal observation egress binding already active.");
        this.egress.set(token, { owner, sessionId: identity.sessionId, attribution });
      },
      releaseHeldOutput: (validated) => {
        if (!input.outputHeld || !held) throw new Error("Terminal observation output is not held.");
        const current = !this.disposed && this.sessions.get(identity.sessionId) === session && session.commands.get(command.id) === owner;
        if (current && command.status === "running") throw new Error("Held terminal observation output released before the command finished.");
        const released = held;
        held = undefined;
        if (!current || !validated) return;
        command.outputTail = released.tail;
        command.outputTruncated = released.truncated;
        this.changed(identity.sessionId);
      },
      revoke: () => {
        if (!active()) return;
        // Drop partial unmasked lines before user input can echo into this command.
        owner.close();
        command.status = "interrupted";
        command.finishedAt = Date.now();
        command.durationMs = Math.max(0, command.finishedAt - command.startedAt);
        for (const viewId of session.views) this.daemon.discardPending(viewId);
        this.changed(identity.sessionId);
      },
    };
  }

  recordEgress(token: string, decision: AgentTerminalEgressDecision): void {
    const binding = this.egress.get(token);
    if (!binding || binding.owner.command.status !== "running") return;
    if (decision.decision !== "allow" && decision.decision !== "deny"
      || decision.port !== null && (!Number.isInteger(decision.port) || decision.port < 1 || decision.port > 65535)) {
      throw new Error("Invalid observed terminal egress decision.");
    }
    const command = binding.owner.command;
    command.decisions.push({ kind: "egress", host: redact(decision.host, 256), port: decision.port,
      decision: decision.decision, basis: decision.basis, scope: decision.scope,
      reason: decision.reason === null ? null : redact(decision.reason, 512), attribution: binding.attribution, ts: Date.now() });
    command.decisions.splice(0, Math.max(0, command.decisions.length - TERMINAL_OBSERVATION_LIMITS.maxDecisions));
    this.changed(binding.sessionId);
  }

  registerView(id: string, sessionId: string, isCurrent: () => boolean, onEvents: (events: TerminalObservationEvent[]) => void): void {
    if (this.views.has(id)) throw new Error("Terminal observation view already registered.");
    const session = this.session(sessionId);
    this.daemon.registerTarget<TerminalObservationEvent>({ id, path: "terminal-activity" }, sessionId, isCurrent, onEvents, "terminal");
    this.views.set(id, { sessionId, isCurrent });
    session.views.add(id);
    this.publish(id);
  }

  acknowledge(id: string, seq: number): void {
    const view = this.views.get(id);
    if (!view || !view.isCurrent()) { this.release(id); throw new Error("Terminal observation view is unavailable."); }
    this.daemon.acknowledge<TerminalObservationEvent>(id, seq);
  }

  release(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.sessions.get(view.sessionId)?.views.delete(id);
    this.views.delete(id);
    this.daemon.release(id);
  }

  releaseSessions(ended: (sessionId: string) => boolean): void {
    for (const id of this.sessions.keys()) if (ended(id)) this.releaseSession(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.sessions.keys()) this.releaseSession(id);
  }

  private releaseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    for (const owner of session.commands.values()) {
      owner.close();
      owner.command.outputTail = "";
      owner.command.decisions = [];
      owner.command.command = "";
      owner.command.cwd = "";
    }
    for (const id of session.views) this.release(id);
    session.commands.clear();
    this.sessions.delete(sessionId);
  }

  private changed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.timer || session.views.size === 0) return;
    session.timer = setTimeout(() => {
      session.timer = undefined;
      for (const id of session.views) this.publish(id);
    }, TERMINAL_OBSERVATION_LIMITS.flushMs);
    session.timer.unref?.();
  }

  private publish(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    if (!view.isCurrent()) { this.release(id); return; }
    const session = this.sessions.get(view.sessionId);
    if (!session) throw new Error("Terminal observation session is unavailable.");
    const now = Date.now();
    const commands = [...session.commands.values()].map(({ command }) => structuredClone({ ...command,
      durationMs: command.status === "running" ? Math.max(0, now - command.startedAt) : command.durationMs }));
    this.daemon.publish<TerminalObservationEvent>(id, { kind: "snapshot", before: null, after: { commands } });
  }
}
