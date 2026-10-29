import { isStagedSendOrigin } from "./staged-origins.js";

export type ChatInputOrigin =
  | "user-keyboard"
  | "plugin-emitted"
  /** App messages remain untrusted after user confirmation; stage or inject them with an app-message provenance envelope. */
  | "app-emitted"
  /** A user-selected server prompt is still server-authored and must never gain keyboard provenance. */
  | "mcp-prompt-emitted"
  /** User-selected template whose text came from an installed agent plugin. */
  | "plugin-prompt-emitted"
  | "llm-tool-arg"
  | "agent-message"
  | "file-content"
  /** The transport mints local-surface provenance; request bodies cannot elevate it to keyboard intent. */
  | "surface-user"
  /** Native remote-controller authority requires local one-shot approval at effects and cannot use remembered grants. */
  | "tailnet-surface"
  /** Verified paired webhooks carry separate controller authority and cannot inherit grants from another transport. */
  | "platform-bridge"
  | "queue-auto";

/** Only the command port mints authority; actor ids are digests rather than raw remote logins. */
export interface TailnetPairingShareBinding {
  /** Local durable pairing record id; never a raw Tailnet identity. */
  readonly pairingId: string;
  /** Pairing generation invalidated by local revoke. */
  readonly pairingEpoch: number;
  /** Local durable conversation-share record id. */
  readonly shareId: string;
  /** Share generation invalidated by local revoke or replacement. */
  readonly shareEpoch: number;
  /** Random public scope, never a persisted conversation/session id. */
  readonly scope: string;
}

/** Pairing-store guards stay host-private and unserialized; direct control retains allow-once semantics. */
export interface TailnetPairedShareGuard {
  isCurrent(binding: TailnetPairingShareBinding): boolean;
}

export interface TailnetControllerAuthority {
  readonly kind: "tailnet-controller";
  readonly actorId: `tailnet:${string}`;
  /** Present only for paired-sharing ingress. */
  readonly pairedShare?: TailnetPairingShareBinding;
  /** Host-private final-boundary revocation check for paired shares. */
  readonly pairedShareGuard?: TailnetPairedShareGuard;
}

export interface PlatformBridgeBinding {
  /** Local durable bridge record id; never a provider account or channel id. */
  readonly bridgeId: string;
  /** Bridge generation invalidated by local revoke. */
  readonly bridgeEpoch: number;
  /** Local durable paired-route record id. */
  readonly routeId: string;
  /** Route generation invalidated by local revoke or replacement. */
  readonly routeEpoch: number;
  /** Random public scope, never a provider conversation or internal session id. */
  readonly scope: string;
}

/** Host-private revocation guard for an admitted external-platform turn. */
export interface PlatformBridgeGuard {
  isCurrent(binding: PlatformBridgeBinding): boolean;
}

/** Provider identity, route pairing, and policy stay isolated across controller transports. */
export interface PlatformBridgeAuthority {
  readonly kind: "platform-bridge";
  readonly actorId: string;
  readonly bridgeBinding: PlatformBridgeBinding;
  readonly bridgeGuard: PlatformBridgeGuard;
}

export type RemoteControllerAuthority = TailnetControllerAuthority | PlatformBridgeAuthority;

/** Malformed, partial, revoked, or failing paired authority denies; missing guards never imply a durable share. */
function isTailnetPairedShareCurrent(
  authority: TailnetControllerAuthority | undefined,
): boolean {
  const binding = authority?.pairedShare;
  const guard = authority?.pairedShareGuard;
  if (binding === undefined && guard === undefined) return true;
  if (binding === undefined || guard === undefined) return false;
  try {
    return guard.isCurrent(binding) === true;
  } catch {
    return false;
  }

}

/** Recheck immediately before effects; direct control is connection-bound and platform ingress always requires pairing. */
export function isRemoteControllerAuthorityCurrent(
  authority: RemoteControllerAuthority | undefined,
): boolean {
  if (authority === undefined) return true;
  if (authority.kind === "tailnet-controller") {
    return isTailnetPairedShareCurrent(authority);
  }
  try {
    return authority.bridgeGuard.isCurrent(authority.bridgeBinding) === true;
  } catch {
    return false;
  }
}

/** Derive record markers from the authority union so every controller kind has a marker. */
export type RemoteControllerOrigin = RemoteControllerAuthority["kind"];

/** Only admitted host authority proves remote provenance; never infer it from localized text or renderer payloads. */
export function remoteControllerOriginOf(
  authority: RemoteControllerAuthority | undefined,
): RemoteControllerOrigin | undefined {
  return authority?.kind;
}
/** The staged registry is total over these origins so extending the union requires registration. */
export type StagedChatInputOrigin = Extract<
  ChatInputOrigin,
  "plugin-emitted" | "app-emitted" | "mcp-prompt-emitted" | "plugin-prompt-emitted"
>;

export type ChatSendInputOrigin =
  | StagedChatInputOrigin
  | Extract<
    ChatInputOrigin,
    "user-keyboard" | "queue-auto" | "surface-user" | "tailnet-surface" | "platform-bridge"
  >;
export type TrustOriginWithUnknown = ChatInputOrigin | "unknown";

export interface ChatSendPayload {
  input: string;
  attachments?: unknown;
  inputOrigin: ChatSendInputOrigin;
  userActivation?: boolean;
  personaPromptId?: string;
}

/** External payloads omit actual provenance; the host adds it at the command boundary. */
export interface ExternalChatSendPayload {
  input: string;
  attachments?: unknown;
}
export interface UserKeyboardIntentSnapshot {
  inputOrigin: "user-keyboard";
  token: string;
}

export interface UserKeyboardIntent {
  inputOrigin: "user-keyboard";
  userActivation: true;
}

/**
 * Turn-entry provenance. Do not pass this through as the tool invocation
 * provenance without reclassifying at the model/tool boundary.
 */
export function isUserKeyboardOrigin(origin: ChatInputOrigin): boolean {
  return origin === "user-keyboard";
}

/** A tool invocation's trust origin carries no content provenance: the arguments are the model's own (`llm-tool-arg`) or the user's
 * keyboard. Any staged, agent, file or surface origin is a taint. */
export function isUntaintedToolTrustOrigin(origin: ChatInputOrigin): origin is "llm-tool-arg" | "user-keyboard" {
  return origin === "llm-tool-arg" || origin === "user-keyboard";
}

/** Non-renderer turns need transcript echo; renderer submissions already create optimistic rows. */
export function isExternalSurfaceInputOrigin(
  origin: string | undefined,
): origin is Extract<ChatInputOrigin, "surface-user" | "tailnet-surface" | "platform-bridge"> {
  return origin === "surface-user"
    || origin === "tailnet-surface"
    || origin === "platform-bridge";
}

export function isChatSendInputOrigin(value: unknown): value is ChatSendInputOrigin {
  // Derive staged guard membership from the registry so runtime checks cannot miss new registered origins.
  return value === "user-keyboard"
    || value === "queue-auto"
    || value === "surface-user"
    || value === "tailnet-surface"
    || value === "platform-bridge"
    || isStagedSendOrigin(value);
}

export function hasUserKeyboardIntent(value: unknown): value is UserKeyboardIntent {
  if (!value || typeof value !== "object") return false;
  const payload = value as { inputOrigin?: unknown; userActivation?: unknown };
  return payload.inputOrigin === "user-keyboard" && payload.userActivation === true;
}

/** Main's proof that one send carries the user's keyboard gesture. Preload minted a one-shot token during the gesture, consumed it for this
 * send, and reported `userActivation: true` over a sender-validated IPC frame (main never sees the token itself); main turns that report into
 * this value. It is unforgeable (only {@link mintUserKeyboardIntent} makes one) and single-use (the turn that receives it spends it). A turn
 * is a user-keyboard turn, and may get user-only capabilities such as typing into the user's own host terminal, only with one. */
export interface VerifiedUserKeyboardIntent {
  readonly kind: "verified-user-keyboard-intent";
}
const mintedUserKeyboardIntents = new WeakSet<object>();

/** The one mint: a verified intent for a send whose IPC payload reports a consumed preload gesture token, otherwise nothing. */
export function mintUserKeyboardIntent(payload: unknown): VerifiedUserKeyboardIntent | undefined {
  if (!hasUserKeyboardIntent(payload)) return undefined;
  const intent: VerifiedUserKeyboardIntent = Object.freeze({ kind: "verified-user-keyboard-intent" as const });
  mintedUserKeyboardIntents.add(intent);
  return intent;
}

/** Spend a verified intent: true once for a minted value, false for a lookalike or a second use. */
export function spendUserKeyboardIntent(intent: unknown): boolean {
  if (typeof intent !== "object" || intent === null || !mintedUserKeyboardIntents.has(intent)) return false;
  mintedUserKeyboardIntents.delete(intent);
  return true;
}

/** Share the missing-keyboard-intent error code across mutation IPC domains. */
export const USER_KEYBOARD_REQUIRED = Object.freeze({
  ok: false as const,
  error: "user-keyboard-required" as const,
});

/** What authorizes a continue: the click's own gesture token, or the grant a branch's click left for its auto-continue. */
export type ContinueAuthority = UserKeyboardIntentSnapshot | { readonly branchContinuation: string };

/** A branch auto-continue whose grant is missing, spent, revoked, lapsed or for another session. */
export const BRANCH_CONTINUATION_REFUSED = Object.freeze({
  ok: false as const,
  error: "branch-continuation-refused" as const,
});

export function hasUserKeyboardIntentPayload(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null
    && hasUserKeyboardIntent((payload as { intent?: unknown }).intent);
}
