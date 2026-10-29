import type { TerminalBlock, TerminalBlockSummary } from "./terminal-blocks.js";
import type { TerminalFileReviewSnapshot } from "./terminal-file-review.js";

export type TerminalIntegrationUnavailableReason = "unsupported-shell" | "missing-home" | "custom-launch" | "setup-failed";

export type TerminalLane = "manual" | "agent";
/** Agent tabId is an opaque main-owned identity, never a workspace tab or renderer authority. */
export interface TerminalRef { readonly tabId: string; readonly lane: TerminalLane }
export interface TerminalSessionRef extends TerminalRef { readonly terminalSessionId: string }

interface TerminalSessionDetails extends TerminalSessionRef {
  readonly initialCwd: string;
  readonly currentCwd: string | null;
  readonly cwdSource: "shell-marker" | "unavailable";
  readonly shellIntegration: boolean;
  readonly integrationUnavailableReason?: TerminalIntegrationUnavailableReason;
}
export type TerminalSessionInfo = TerminalSessionDetails & (
  | { readonly lane: "manual"; readonly substrate: "host" }
  | { readonly lane: "agent"; readonly substrate: "asrt"; readonly sandboxGeneration: string }
);
export interface TerminalSpawnRequest extends TerminalRef {
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
}
export type TerminalMutationResult = { readonly ok: true } | { readonly ok: false; readonly error: string };
export type TerminalSpawnResult =
  | { readonly ok: true; readonly tabId: string; readonly replayed: boolean; readonly session: TerminalSessionInfo }
  | { readonly ok: false; readonly reason: "not-shell-contained" | "bad-request" | "spawn-failed" | "too-many-terminals" | "still-closing" | "no-terminal" | "unauthorized-frame"; readonly message: string };
export type TerminalDataEvent = TerminalSessionRef & { readonly chunk: string };
export type TerminalExitEvent = TerminalSessionRef & { readonly exitCode: number; readonly signal?: number };

export interface TerminalApi {
  /** Host sessions retain cwd and geometry; replay can precede the incarnation reply. Renderer requests admit only the manual lane. */
  spawn(request: TerminalSpawnRequest): Promise<TerminalSpawnResult>;
  /** Input, resize and block reads reject a replaced/closed incarnation. */
  input(ref: TerminalSessionRef, data: string): Promise<TerminalMutationResult>;
  resize(ref: TerminalSessionRef, cols: number, rows: number): Promise<TerminalMutationResult>;
  /** Trusted tab closure cancels and terminates only the host terminal. */
  kill(tabId: string): Promise<TerminalMutationResult>;
  listBlocks(ref: TerminalSessionRef): Promise<
    | { readonly ok: true; readonly session: TerminalSessionInfo; readonly integrated: boolean; readonly blocks: TerminalBlockSummary[] }
    | { readonly ok: false; readonly error: string }
  >;
  getBlock(ref: TerminalSessionRef, blockId: number): Promise<
    | { readonly ok: true; readonly session: TerminalSessionInfo; readonly block: TerminalBlock }
    | { readonly ok: false; readonly error: string }
  >;
  listFileReviews(ref: TerminalSessionRef): Promise<
    | { readonly ok: true; readonly snapshot: TerminalFileReviewSnapshot }
    | { readonly ok: false; readonly error: string }
  >;
  reviewFiles(ref: TerminalSessionRef, files: readonly { path: string; hash: string }[]): Promise<TerminalMutationResult>;
  onData(handler: (event: TerminalDataEvent) => void): () => void;
  onExit(handler: (event: TerminalExitEvent) => void): () => void;
}

export function isTerminalLane(value: unknown): value is TerminalLane {
  return value === "manual" || value === "agent";
}

export function isTerminalSessionRef(value: unknown): value is TerminalSessionRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.tabId === "string" && ref.tabId.length > 0 && isTerminalLane(ref.lane)
    && typeof ref.terminalSessionId === "string" && ref.terminalSessionId.length > 0;
}

/** Logical IDs cannot contain the separator (tab-id.ts validates them). */
export function terminalLaneKey(ref: TerminalRef): string {
  return `${ref.tabId}/${ref.lane}`;
}

export function sameTerminalSession(left: TerminalSessionRef, right: TerminalSessionRef): boolean {
  return left.tabId === right.tabId && left.lane === right.lane && left.terminalSessionId === right.terminalSessionId;
}

export function parseTerminalSessionRef(value: unknown): TerminalSessionRef | null {
  if (!isTerminalSessionRef(value)) return null;
  return { tabId: value.tabId, lane: value.lane, terminalSessionId: value.terminalSessionId };
}
export function parseTerminalDataEvent(value: unknown): TerminalDataEvent | null {
  const ref = parseTerminalSessionRef(value);
  if (!ref || typeof value !== "object" || value === null || !("chunk" in value) || typeof value.chunk !== "string") return null;
  return { ...ref, chunk: value.chunk };
}
export function parseTerminalExitEvent(value: unknown): TerminalExitEvent | null {
  const ref = parseTerminalSessionRef(value);
  if (!ref || typeof value !== "object" || value === null || !("exitCode" in value) || !Number.isInteger(value.exitCode)) return null;
  if ("signal" in value && value.signal !== undefined && !Number.isInteger(value.signal)) return null;
  return { ...ref, exitCode: value.exitCode as number, ...("signal" in value && typeof value.signal === "number" ? { signal: value.signal } : {}) };
}
