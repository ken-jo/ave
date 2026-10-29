/** Who controls one host terminal incarnation, and which output an approved agent command may disclose.
 * The user holds control by default. One approved command acquires a generation-bound agent lease; any user input, Take over,
 * Stop, purpose or binding loss revokes it synchronously, before the user's bytes reach the shell. Agent bytes pass the
 * lease check at the final write. Output is attributed when the PTY delivers it: only bytes received while the lease held
 * control enter that command's disclosure span, and a revoked span drops its undelivered parser tail. Bytes already written
 * to the operating system cannot be retracted; nothing here claims otherwise. */
import type { HostTerminalControlMode, HostTerminalControlState } from "../../shared/terminal-session.js";

/** Characters a disclosure span keeps; the newest are kept when a command prints more. */
export const HOST_DISCLOSURE_MAX_CHARS = 96 * 1024;
/** Completed spans kept per incarnation for their requesting conversation's continuation reads. */
const MAX_RETAINED_DISCLOSURES = 8;

export type HostLeaseRevocation = "user-input" | "take-over" | "stop" | "purpose" | "binding" | "closed";

/** The output one approved command disclosed to the conversation that requested it. */
export interface HostTerminalDisclosure {
  readonly requestingSessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly blockId: number;
  /** `running` while the lease holds; `done` after the authenticated exit marker arrived under it; `interrupted` when the lease
   * was revoked first (the command may still run, now in the user's period, and nothing further is disclosed). */
  readonly state: "running" | "done" | "interrupted";
  readonly exitCode: number | null;
  readonly output: string;
  /** Older output was dropped to stay within {@link HOST_DISCLOSURE_MAX_CHARS}. */
  readonly truncated: boolean;
  readonly interruption?: HostLeaseRevocation | "command-mismatch";
}

interface MutableDisclosure {
  requestingSessionId: string;
  command: string;
  cwd: string;
  blockId: number;
  state: HostTerminalDisclosure["state"];
  exitCode: number | null;
  output: string;
  truncated: boolean;
  interruption?: HostLeaseRevocation | "command-mismatch";
}

/** One admitted command's control. Typing checks {@link HostTerminalControl.holds} before every byte. */
export interface HostAgentLease {
  readonly generation: number;
  readonly requestingSessionId: string;
  readonly command: string;
  readonly cwd: string;
  /** Aborted when the lease is revoked or released: pending typing stops at its next await. */
  readonly signal: AbortSignal;
}

interface LeaseRecord extends HostAgentLease {
  readonly abort: AbortController;
  disclosure?: MutableDisclosure;
  /** Detach from the PTY output stream; `flush` is true only for an authenticated completion under the lease. */
  detach?: (flush: boolean) => void;
}

export type HostAdmission =
  | { readonly ok: true; readonly lease: HostAgentLease }
  | { readonly ok: false; readonly reason: "agent-running" | "taken-over"; readonly message: string };

export class HostTerminalControl {
  private mode: HostTerminalControlMode = "available";
  private generation = 0;
  private lease: LeaseRecord | undefined;
  private readonly disclosures: MutableDisclosure[] = [];
  private readonly listeners = new Set<(state: HostTerminalControlState) => void>();

  state(): HostTerminalControlState {
    return {
      mode: this.mode,
      generation: this.generation,
      ...(this.lease === undefined ? {} : { command: this.lease.command, typed: this.lease.disclosure !== undefined }),
    };
  }

  onChange(listener: (state: HostTerminalControlState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Acquire the one agent lease for an approved command. Refused while another lease holds or after a take-over that was not handed back. */
  admit(requestingSessionId: string, command: string, cwd: string): HostAdmission {
    if (this.mode === "agent") return { ok: false, reason: "agent-running", message: "another approved agent command still holds this terminal" };
    if (this.mode === "taken-over") {
      return { ok: false, reason: "taken-over", message: "the user took over this terminal; they must hand it back before the agent can type again" };
    }
    const abort = new AbortController();
    this.generation += 1;
    const lease: LeaseRecord = { generation: this.generation, requestingSessionId, command, cwd, abort, signal: abort.signal };
    this.lease = lease;
    this.mode = "agent";
    this.changed();
    return { ok: true, lease };
  }

  /** True only while `lease` is the live lease. The final PTY write chokepoint asks this for every agent byte. */
  holds(lease: HostAgentLease): boolean {
    return this.lease !== undefined && this.lease === lease && this.lease.generation === this.generation && this.mode === "agent";
  }

  /** Start the lease's disclosure span at the block Enter opens. `attach` subscribes to that block's output and returns its detach. */
  beginDisclosure(lease: HostAgentLease, blockId: number, attach: (append: (text: string) => void) => (flush: boolean) => void): void {
    const record = this.liveRecord(lease);
    if (!record || record.disclosure) throw new Error("Host terminal disclosure requires the live lease before Enter.");
    const disclosure: MutableDisclosure = {
      requestingSessionId: record.requestingSessionId, command: record.command, cwd: record.cwd, blockId,
      state: "running", exitCode: null, output: "", truncated: false,
    };
    record.disclosure = disclosure;
    this.retain(disclosure);
    record.detach = attach((text) => {
      // Attribution at receipt: output that arrives after a revocation belongs to the user's period.
      if (this.lease !== record || disclosure.state !== "running") return;
      const output = disclosure.output + text;
      if (output.length > HOST_DISCLOSURE_MAX_CHARS) {
        disclosure.output = output.slice(output.length - HOST_DISCLOSURE_MAX_CHARS);
        disclosure.truncated = true;
      } else disclosure.output = output;
    });
    this.changed();
  }

  /** The block's authenticated exit marker arrived while the lease held: flush its delivered tail, record the exit code, return control to the user. */
  complete(lease: HostAgentLease, exitCode: number | null): void {
    const record = this.liveRecord(lease);
    if (!record?.disclosure) return;
    record.detach?.(true);
    record.disclosure.state = "done";
    record.disclosure.exitCode = exitCode;
    this.endLease(record, "available");
  }

  /** The shell ran something other than the approved line: stop disclosure at once, as for a revocation. */
  mismatch(lease: HostAgentLease): void {
    const record = this.liveRecord(lease);
    if (!record) return;
    this.closeSpan(record, "command-mismatch");
    this.endLease(record, "taken-over");
  }

  /** Release a lease whose typing failed before Enter: nothing ran, so the user simply keeps control and the terminal stays available. */
  abandon(lease: HostAgentLease): void {
    const record = this.liveRecord(lease);
    if (!record || record.disclosure) return;
    this.endLease(record, "available");
  }

  /** Revoke the live lease, if any. Synchronous: callers forward user bytes only after this returns. Returns the revoked lease. */
  revoke(reason: HostLeaseRevocation): HostAgentLease | undefined {
    const record = this.lease;
    if (!record) {
      if (reason === "closed" && this.mode !== "available") {
        this.mode = "available";
        this.generation += 1;
        this.changed();
      }
      return undefined;
    }
    this.closeSpan(record, reason);
    this.endLease(record, reason === "closed" ? "available" : "taken-over");
    return record;
  }

  /** Hand control back after a take-over. Allowed only at a fresh empty attested prompt; it enables the next admission and resumes nothing. */
  handBack(promptReady: boolean): { ok: true } | { ok: false; reason: "not-taken-over" | "prompt-not-ready"; message: string } {
    if (this.mode !== "taken-over") return { ok: false, reason: "not-taken-over", message: "the terminal is not taken over" };
    if (!promptReady) {
      return { ok: false, reason: "prompt-not-ready", message: "clear or run the line first; hand back needs an empty prompt" };
    }
    this.mode = "available";
    this.generation += 1;
    this.changed();
    return { ok: true };
  }

  /** The span `blockId` disclosed to `requestingSessionId`, never another conversation's. */
  disclosure(requestingSessionId: string, blockId: number): HostTerminalDisclosure | undefined {
    const found = this.disclosures.find((entry) => entry.blockId === blockId && entry.requestingSessionId === requestingSessionId);
    return found === undefined ? undefined : snapshot(found);
  }

  private liveRecord(lease: HostAgentLease): LeaseRecord | undefined {
    return this.holds(lease) ? this.lease : undefined;
  }

  private closeSpan(record: LeaseRecord, reason: HostLeaseRevocation | "command-mismatch"): void {
    // Undelivered parser and redaction tails are discarded, so a token split at the revocation cannot carry user-period bytes.
    record.detach?.(false);
    record.detach = undefined;
    if (record.disclosure && record.disclosure.state === "running") {
      record.disclosure.state = "interrupted";
      record.disclosure.interruption = reason;
    }
  }

  private endLease(record: LeaseRecord, mode: HostTerminalControlMode): void {
    record.detach = undefined;
    this.lease = undefined;
    this.mode = mode;
    this.generation += 1;
    record.abort.abort(new Error("host terminal agent lease ended"));
    this.changed();
  }

  private retain(disclosure: MutableDisclosure): void {
    this.disclosures.push(disclosure);
    while (this.disclosures.length > MAX_RETAINED_DISCLOSURES) this.disclosures.shift();
  }

  private changed(): void {
    const state = this.state();
    for (const listener of [...this.listeners]) listener(state);
  }
}

function snapshot(entry: MutableDisclosure): HostTerminalDisclosure {
  return {
    requestingSessionId: entry.requestingSessionId, command: entry.command, cwd: entry.cwd, blockId: entry.blockId,
    state: entry.state, exitCode: entry.exitCode, output: entry.output, truncated: entry.truncated,
    ...(entry.interruption === undefined ? {} : { interruption: entry.interruption }),
  };
}
