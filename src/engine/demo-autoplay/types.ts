/**
 * Live Auto-play — contract types.
 *
 * Demo-only. Shared between `ScriptedTurnEngine`, `FakeSandbox`,
 * `DemoAutoplayBanner`, and the per-script JSON fixtures under
 * `./scripts/<id>.json`. See
 * `docs/architecture/proposals/live-autoplay.md` §3 for the SOT contract.
 *
 * Invariant: types defined here never escape into `ConversationLoop`
 * or `tool-registry`. All consumers stay inside the renderer-local
 * autoplay surface so the demo trust boundary is enforceable at
 * import-time.
 */

/** Pre-recorded turn — fully self-contained, no LLM/tool runtime touched. */
export interface ScriptedTurn {
  /** Stable id (slug). Loaded from scripts/<id>.json. */
  id: string;
  /** Localized title shown in the REC indicator / audit prefix. */
  titleKo: string;
  /** Simulated user message — emitted with type-on animation. */
  userMessage: string;
  /** Tool call sequence — each call returns a sandboxed fake result. */
  toolCalls: ScriptedToolCall[];
  /** Final assistant response — emitted with type-on animation. */
  assistantResponse: string;
  /**
   * Type-on speed (ms / char). Default 25. Per-character delay keeps the
   * "user is typing" illusion consistent with the mockup cadence.
   */
  typeOnMsPerChar?: number;
}

export interface ScriptedToolCall {
  /**
   * Tool name (e.g. `meeting_list`). The string is *display only* — the
   * engine NEVER routes this through `tool-registry.ts`. Real tools never
   * see autoplay calls.
   */
  toolName: string;
  /** Korean label shown next to the tool name (mockup parity). */
  labelKo: string;
  /**
   * Pre-computed fake result — plain string only, no nested LLM JSON.
   * `fakeResultKo` is prefixed with `데모: ` at render time so the user can
   * never visually mistake it for a real tool result.
   */
  fakeResultKo: string;
  /** Optional delay before this call fires (ms). Default 600. */
  delayMs?: number;
}

/**
 * Reason a scripted turn ended. The engine reports the cause so
 * `auditLogger` and view-cleanup logic can branch.
 */
export type ScriptedAbortReason =
  | "user-takeover"
  | "user-input"
  | "external"
  | "completed";

/**
 * Sink the engine writes into. The ChatView-side implementation
 * accumulates entries with `kind: "demo-autoplay-*"` so they live in
 * a view-only history that never reaches `ConversationLoop`.
 */
export interface ScriptedSink {
  emitUserMessage(text: string, isFinal: boolean): void;
  emitToolCall(call: ScriptedToolCall, status: "running" | "done"): void;
  emitToolResult(call: ScriptedToolCall, resultKo: string): void;
  emitAssistantDelta(text: string, isFinal: boolean): void;
  /** Engine has stopped — sink should clear scripted entries from view. */
  onAborted(reason: ScriptedAbortReason): void;
}

/**
 * Activation gate inputs. Centralised so both the renderer entry decision
 * and any future main-process IPC use the same predicate.
 */
export interface DemoActivationInputs {
  /** `settings.features.demoAutoplayEnabled` */
  flagEnabled: boolean | undefined;
  /** `settings.features.onboardingCompleted` */
  onboardingCompleted: boolean | undefined;
  /** Whether `process.env.AVE_DEMO_VENDOR` was set at boot. */
  demoVendorPresent: boolean;
}

/**
 * §7 of the proposal: activation predicate. Spelled out so the truth table
 * is testable in isolation.
 *
 * Demo activates iff:
 *   (A) `demoAutoplayEnabled === true` OR `onboardingCompleted` is not yet true
 *   AND
 *   (B) `AVE_DEMO_VENDOR` is present
 *   AND
 *   (C) user did NOT explicitly opt out (`demoAutoplayEnabled === false`)
 *
 * Resulting truth table (encoded for tests):
 *   flag=true    + completed=*    + vendor=true  → activate
 *   flag=undef   + completed=undef + vendor=true → activate (first run)
 *   flag=undef   + completed=true  + vendor=true → skip (already onboarded)
 *   flag=false   + completed=*    + vendor=true  → skip (explicit opt-out)
 *   *            + *              + vendor=false → skip (production dead path)
 */
export function shouldActivateDemoAutoplay(inputs: DemoActivationInputs): boolean {
  if (!inputs.demoVendorPresent) return false;
  if (inputs.flagEnabled === false) return false;
  if (inputs.flagEnabled === true) return true;
  // flag undefined → first-run gate
  return inputs.onboardingCompleted !== true;
}
