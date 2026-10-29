import type { TerminalBlock, TerminalBlockSummary } from "./terminal-blocks.js";

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
/** Where a host terminal is mounted. Only a workspace pane's terminal can take approved agent commands from its own pane chat; a side
 * panel terminal never can. The trusted host renderer declares it on every mount, since one tab can move between the two. */
export type TerminalPurpose = "workspace" | "side-panel";
export function isTerminalPurpose(value: unknown): value is TerminalPurpose {
  return value === "workspace" || value === "side-panel";
}
export interface TerminalSpawnRequest extends TerminalRef {
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
  /** Required for a host (manual) spawn or replay. */
  readonly purpose?: TerminalPurpose;
}
/** Who controls a host terminal: the user (`available` for the next approved command, or `taken-over` until they hand it back), or
 * one approved agent command (`agent`). Main owns it; the renderer only shows it and asks for a change. */
export type HostTerminalControlMode = "available" | "agent" | "taken-over";
export interface HostTerminalControlState {
  readonly mode: HostTerminalControlMode;
  readonly generation: number;
  /** The approved command holding the lease (agent mode only). */
  readonly command?: string;
  /** Enter was pressed for it. */
  readonly typed?: boolean;
}
export type TerminalControlEvent = TerminalSessionRef & { readonly control: HostTerminalControlState };
export type TerminalControlAction = "get" | "take-over" | "stop" | "hand-back";
export function isTerminalControlAction(value: unknown): value is TerminalControlAction {
  return value === "get" || value === "take-over" || value === "stop" || value === "hand-back";
}
export type TerminalControlResult =
  | { readonly ok: true; readonly control: HostTerminalControlState }
  | { readonly ok: false; readonly error: string; readonly message?: string };
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
  /** Read or change who controls a host terminal: Take over, Stop the agent's command, or Hand back. */
  control(ref: TerminalSessionRef, action: TerminalControlAction): Promise<TerminalControlResult>;
  onData(handler: (event: TerminalDataEvent) => void): () => void;
  onExit(handler: (event: TerminalExitEvent) => void): () => void;
  onControl(handler: (event: TerminalControlEvent) => void): () => void;
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
const CONTROL_MODES: ReadonlySet<string> = new Set(["available", "agent", "taken-over"]);
export function parseTerminalControlEvent(value: unknown): TerminalControlEvent | null {
  const ref = parseTerminalSessionRef(value);
  if (!ref || typeof value !== "object" || value === null || !("control" in value)) return null;
  const control = value.control as Record<string, unknown> | null;
  if (typeof control !== "object" || control === null || typeof control.mode !== "string" || !CONTROL_MODES.has(control.mode)
    || !Number.isInteger(control.generation)
    || (control.command !== undefined && typeof control.command !== "string")
    || (control.typed !== undefined && typeof control.typed !== "boolean")) return null;
  return { ...ref, control: {
    mode: control.mode as HostTerminalControlMode, generation: control.generation as number,
    ...(typeof control.command === "string" ? { command: control.command } : {}),
    ...(typeof control.typed === "boolean" ? { typed: control.typed } : {}),
  } };
}
