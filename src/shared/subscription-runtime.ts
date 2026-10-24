/**
 * Browser-safe common contract for subscription-backed chat runtimes.
 *
 * API-key vendors deliberately remain in `llm-vendor-defaults.ts`.  A
 * subscription runtime owns its own credential store and stateful transport,
 * so treating one as an API vendor would leak the wrong settings, fallback,
 * pricing, and tool-execution assumptions into the application.
 */
import { CODEX_CLI_MINIMUM_VERSION } from "./codex-subscription.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "./safe-integer.js";

const SUBSCRIPTION_RUNTIME_IDS = ["codex", "kimi-code", "grok-build", "claude-code"] as const;

export type SubscriptionRuntimeId = (typeof SUBSCRIPTION_RUNTIME_IDS)[number];
/** Shared cap for model ids carried by subscription runtime contracts. */
export const MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH = 200;

/**
 * Wire contract of the loopback tool bridge between the main process and the
 * stdio MCP shim it spawns for ACP runtimes. Both ends validate the same
 * payloads — the bridge bounds the tool set it publishes, the shim bounds the
 * `tools/list` and `tools/call` bodies it reads back — so the bounds and the
 * environment handoff keys are declared once and imported by both, and one
 * side cannot accept what the other refuses.
 */
export const SUBSCRIPTION_TOOL_BRIDGE_CONTRACT = Object.freeze({
  urlEnv: "AVE_SUBSCRIPTION_TOOL_BRIDGE_URL",
  tokenEnv: "AVE_SUBSCRIPTION_TOOL_BRIDGE_TOKEN",
  maxToolCount: 256,
  maxSchemaBytes: 64 * 1024,
  /** Host defensive UTF-8 budget; descriptions are preserved, never truncated. */
  maxDescriptionBytes: 64 * 1024,
  /** Complete serialized tool-list response, including schemas and JSON framing. */
  maxBridgeResponseBytes: 512 * 1024,
  maxJsonDepth: 16,
  maxJsonKeys: 1_024,
  maxJsonArrayItems: 1_024,
  maxJsonStringLength: 64 * 1024,
  maxToolNameLength: 128,
} as const);

/** Shared text admission for every subscription tool transport. */
export function isSubscriptionToolDescription(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxDescriptionBytes
    && !/[\u0000\u007f]/.test(value)
    && new TextEncoder().encode(value).byteLength <= SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxDescriptionBytes;
}

/**
 * The name a host tool travels under on the subscription tool bridge: minted
 * by the bridge (a host name that already fits passes through, anything else
 * becomes `ave_<sha>`), then checked again by the MCP shim on every
 * `tools/list` entry and `tools/call`. One grammar for the two ends of the
 * wire — a leading letter, then letters, digits, `_` or `-`, at most
 * `maxToolNameLength` characters.
 */
const SUBSCRIPTION_BRIDGE_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

export function isSubscriptionBridgeToolName(name: unknown): name is string {
  return typeof name === "string" && SUBSCRIPTION_BRIDGE_TOOL_NAME_PATTERN.test(name);
}

/**
 * Provenance of a subscription-runtime token segment.
 *
 * This is deliberately separate from `TokenUsage`: API-key usage is a
 * billable pricing contract, whereas these values describe consumption under
 * an already-authenticated subscription. A local estimate must never be
 * presented as provider-reported usage.
 */
export type SubscriptionUsageSource = "provider-reported" | "local-estimate";

/**
 * Renderer-safe per-round subscription usage.
 *
 * `totalTokens` is the provider's exact per-turn total where available, or
 * the sum of the locally-estimated input/output values. It is never an API
 * price input. `billable: false` makes the non-pricing boundary explicit at
 * every persistence and IPC hop.
 */
export interface SubscriptionUsageTelemetry {
  readonly provider: SubscriptionRuntimeId;
  readonly model: string;
  readonly source: SubscriptionUsageSource;
  readonly billable: false;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningOutputTokens?: number;
  /** Provider metadata only; it is not used to re-enable the context ring. */
  readonly contextWindow?: number;
}

const SUBSCRIPTION_USAGE_TELEMETRY_KEYS = new Set([
  "provider",
  "model",
  "source",
  "billable",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningOutputTokens",
  "contextWindow",
]);

/**
 * Validates and copies telemetry arriving from transport, persisted history,
 * or IPC. Unknown fields are rejected so raw provider payloads cannot leak
 * across the main/renderer boundary by being carried incidentally.
 */
export function normalizeSubscriptionUsageTelemetry(
  value: unknown,
): SubscriptionUsageTelemetry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const payload = value as Record<string, unknown>;
    if (Object.keys(payload).some((key) => !SUBSCRIPTION_USAGE_TELEMETRY_KEYS.has(key))) {
      return undefined;
    }
    const provider = payload.provider;
    const model = payload.model;
    const source = payload.source;
    if (
      !isSubscriptionRuntimeId(provider)
      || typeof model !== "string"
      || model.length === 0
      || model.length > MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH
      || (source !== "provider-reported" && source !== "local-estimate")
      || payload.billable !== false
      || !isNonNegativeSafeInteger(payload.inputTokens)
      || !isNonNegativeSafeInteger(payload.outputTokens)
      || !isNonNegativeSafeInteger(payload.totalTokens)
      || (payload.cacheReadTokens !== undefined && !isNonNegativeSafeInteger(payload.cacheReadTokens))
      || (payload.cacheWriteTokens !== undefined && !isNonNegativeSafeInteger(payload.cacheWriteTokens))
      || (payload.reasoningOutputTokens !== undefined && !isNonNegativeSafeInteger(payload.reasoningOutputTokens))
      || (payload.contextWindow !== undefined && !isPositiveSafeInteger(payload.contextWindow))
    ) {
      return undefined;
    }
    return {
      provider,
      model,
      source,
      billable: false,
      inputTokens: payload.inputTokens,
      outputTokens: payload.outputTokens,
      totalTokens: payload.totalTokens,
      ...(payload.cacheReadTokens !== undefined ? { cacheReadTokens: payload.cacheReadTokens } : {}),
      ...(payload.cacheWriteTokens !== undefined ? { cacheWriteTokens: payload.cacheWriteTokens } : {}),
      ...(payload.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: payload.reasoningOutputTokens }
        : {}),
      ...(payload.contextWindow !== undefined ? { contextWindow: payload.contextWindow } : {}),
    };
  } catch {
    return undefined;
  }
}

export function isSubscriptionRuntimeId(value: unknown): value is SubscriptionRuntimeId {
  return typeof value === "string"
    && (SUBSCRIPTION_RUNTIME_IDS as readonly string[]).includes(value);
}

/**
 * Main-to-renderer invalidation event for a subscription runtime status.
 *
 * This intentionally carries no runtime status, verification URL, executable
 * path, credential, or raw provider output. Consumers re-read the existing
 * safe status projection after observing a newer revision.
 */
export interface SubscriptionRuntimeStatusUpdatedEvent {
  readonly provider: SubscriptionRuntimeId;
  readonly revision: number;
}

/** Reject malformed or expanded event payloads at the preload boundary. */
export function isSubscriptionRuntimeStatusUpdatedEvent(
  value: unknown,
): value is SubscriptionRuntimeStatusUpdatedEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  return keys.length === 2
    && Object.prototype.hasOwnProperty.call(payload, "provider")
    && Object.prototype.hasOwnProperty.call(payload, "revision")
    && isSubscriptionRuntimeId(payload.provider)
    && typeof payload.revision === "number"
    && Number.isSafeInteger(payload.revision)
    && payload.revision > 0;
}

type SubscriptionRuntimeTransport = "codex-app-server" | "acp" | "claude-cli";

export type SubscriptionLoginMethod = "browser" | "device-code";

export type SubscriptionRuntimeState =
  | "not-configured"
  | "unverified"
  | "ready"
  | "unavailable";

export type SubscriptionConnectionState =
  | "connected"
  | "pending"
  | "signed-out"
  | "unknown";

/**
 * Selection persisted under `llm.activeChatRuntime`.
 *
 * `model` is intentionally optional: ACP providers may expose only their
 * own default model, while Codex may enumerate subscription-scoped models.
 */
export interface SubscriptionChatRuntimeSelection {
  kind: "subscription";
  provider: SubscriptionRuntimeId;
  model?: string;
}

interface ApiChatRuntimeSelection {
  kind: "api";
}

export type ActiveChatRuntime = ApiChatRuntimeSelection | SubscriptionChatRuntimeSelection;

/**
 * How a runtime's official CLI is found. `discovered`: Ave looks for the CLI
 * the user installed (PATH and the official install locations) and the user
 * never picks a file. `user-selected`: the user points Ave at the executable.
 */
export type SubscriptionRuntimeExecutableSource = "discovered" | "user-selected";

export interface SubscriptionRuntimeDescriptor {
  id: SubscriptionRuntimeId;
  /**
   * Internal runtime name for logs and audit. Settings names the company
   * (the API counterpart's label) and the plan (`planName`), never this.
   */
  label: string;
  /** The subscription plan as the provider brands it ("ChatGPT", "Claude"). */
  planName: string;
  /** The CLI's own name, used only to say what to install. */
  cliName: string;
  transport: SubscriptionRuntimeTransport;
  executable: SubscriptionRuntimeExecutableSource;
  loginMethods: readonly SubscriptionLoginMethod[];
  supportsManagedLogout: boolean;
  /** Only surface a picker when the runtime supplies a trustworthy model list. */
  supportsModelSelection: boolean;
  /** The oldest CLI version Ave can run, when the runtime enforces one. */
  minimumVersion?: string;
  /** Official install instructions shown while no runtime is found. */
  installGuidance?: SubscriptionRuntimeInstallGuidance;
}

/**
 * How the provider's own documentation says to install its CLI. Shown as
 * text; Ave never runs these commands.
 */
export interface SubscriptionRuntimeInstallGuidance {
  readonly documentationUrl: string;
  readonly commands: readonly { readonly label: string; readonly command: string }[];
}

/**
 * Main-verified feature availability for a subscription runtime.
 *
 * These are deliberately booleans rather than promises about a provider's
 * native client. A value may be `true` only after the Ave-owned runtime has
 * confirmed that the feature is available through the same host permission,
 * audit, project, and lifecycle paths as an API-key provider. A missing
 * status projection is treated as unknown by the renderer, never as enabled.
 */
export interface SubscriptionImageAttachmentLimits {
  /** Maximum original images accepted for one subscription prompt. */
  readonly maxCount: number;
  /** Maximum decoded bytes for any one original image. */
  readonly maxBytesPerImage: number;
  /** Maximum decoded bytes across all original images in one prompt. */
  readonly maxTotalBytes: number;
}

export interface SubscriptionRuntimeCapabilities {
  readonly chat: boolean;
  /** The runtime accepts original image bytes through its negotiated transport. */
  readonly images: boolean;
  /**
   * Main-verified native image budget, or null when images are unavailable.
   * This is distinct from the normal file-marker/read-tool flow.
   */
  readonly imageAttachmentLimits: SubscriptionImageAttachmentLimits | null;
  /** The normal Ave file marker + governed read-tool flow is available. */
  readonly files: boolean;
  readonly tools: boolean;
  readonly projectAccess: boolean;
  readonly plugins: boolean;
  readonly mcp: boolean;
  readonly generateText: boolean;
  readonly compaction: boolean;
  readonly routine: boolean;
  readonly subagent: boolean;
}

/**
 * The API-key vendor that reaches the same provider as a subscription runtime.
 *
 * A user recognises OpenAI, Anthropic, xAI, and Moonshot as one company each — the two
 * ways in are an API key or signing in to that company's runtime, not two
 * providers with similar names. Settings lists the provider once and offers
 * the authentication methods, and this is the join that makes that possible.
 *
 * Values are the ids the LLM vendor settings already use: a built-in vendor id
 * for OpenAI, an OpenAI-compatible preset id for the other two. A runtime with
 * no key-based route simply has no entry.
 */
export const SUBSCRIPTION_RUNTIME_API_COUNTERPART: Readonly<
  Partial<Record<SubscriptionRuntimeId, string>>
> = Object.freeze({
  codex: "openai",
  "claude-code": "claude",
  "grok-build": "xai",
  "kimi-code": "moonshot",
});

/** Safe capability projection when a runtime has not verified a feature. */
export const DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES: SubscriptionRuntimeCapabilities = Object.freeze({
  chat: false,
  images: false,
  imageAttachmentLimits: null,
  files: false,
  tools: false,
  projectAccess: false,
  plugins: false,
  mcp: false,
  generateText: false,
  compaction: false,
  routine: false,
  subagent: false,
});

export const SUBSCRIPTION_RUNTIME_DESCRIPTORS: readonly SubscriptionRuntimeDescriptor[] = [
  {
    id: "codex",
    label: "Codex",
    planName: "ChatGPT",
    cliName: "Codex CLI",
    transport: "codex-app-server",
    // The user's own `codex` CLI, found on PATH or in an official install
    // location. Ave ships none, and the user never picks the file.
    executable: "discovered",
    loginMethods: ["browser", "device-code"],
    supportsManagedLogout: true,
    supportsModelSelection: true,
    minimumVersion: CODEX_CLI_MINIMUM_VERSION,
    installGuidance: Object.freeze({
      documentationUrl: "https://learn.chatgpt.com/docs/codex/cli",
      commands: Object.freeze([
        Object.freeze({ label: "macOS / Linux", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" }),
        Object.freeze({
          label: "Windows (PowerShell)",
          command: "powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"",
        }),
        Object.freeze({ label: "npm", command: "npm install -g @openai/codex" }),
        Object.freeze({ label: "Homebrew", command: "brew install --cask codex" }),
      ]),
    }),
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    planName: "Kimi",
    cliName: "Kimi Code CLI",
    transport: "acp",
    executable: "user-selected",
    loginMethods: ["device-code"],
    supportsManagedLogout: false,
    supportsModelSelection: false,
  },
  {
    id: "grok-build",
    label: "Grok Build",
    planName: "Grok",
    cliName: "Grok Build CLI",
    transport: "acp",
    executable: "user-selected",
    loginMethods: ["device-code"],
    supportsManagedLogout: true,
    supportsModelSelection: false,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    planName: "Claude",
    cliName: "Claude Code CLI",
    transport: "claude-cli",
    // The user's own `claude` CLI, found on PATH or in an official install
    // location and qualified against the options Ave passes.
    executable: "discovered",
    loginMethods: ["browser"],
    supportsManagedLogout: true,
    supportsModelSelection: false,
    installGuidance: Object.freeze({
      documentationUrl: "https://code.claude.com/docs/en/setup",
      commands: Object.freeze([
        Object.freeze({ label: "macOS / Linux", command: "curl -fsSL https://claude.ai/install.sh | bash" }),
        Object.freeze({ label: "Windows (PowerShell)", command: "irm https://claude.ai/install.ps1 | iex" }),
        Object.freeze({ label: "Homebrew", command: "brew install --cask claude-code" }),
        Object.freeze({ label: "WinGet", command: "winget install Anthropic.ClaudeCode" }),
        Object.freeze({ label: "npm", command: "npm install -g @anthropic-ai/claude-code" }),
      ]),
    }),
  },
] as const;

export function subscriptionRuntimeDescriptor(
  runtimeId: SubscriptionRuntimeId,
): SubscriptionRuntimeDescriptor {
  return SUBSCRIPTION_RUNTIME_DESCRIPTORS.find((descriptor) => descriptor.id === runtimeId)
    ?? SUBSCRIPTION_RUNTIME_DESCRIPTORS[0]!;
}

/**
 * Safe status projection used by renderer IPC. Dynamic verification URLs,
 * access tokens, raw CLI output, and executable paths never appear here.
 */
export interface SubscriptionRuntimeStatus {
  provider: SubscriptionRuntimeId;
  runtime: SubscriptionRuntimeState;
  connection: SubscriptionConnectionState;
  planType: string | null;
  pendingLogin: SubscriptionLoginMethod | null;
  pendingDeviceCode: string | null;
  canOpenVerificationUrl: boolean;
  version: string | null;
  /**
   * Host-verified feature availability. The renderer must treat an omitted or
   * false value as unavailable; provider-native capability claims are not
   * sufficient on their own.
   */
  capabilities: SubscriptionRuntimeCapabilities;
}

export interface SubscriptionRuntimeModel {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export type SubscriptionRuntimeErrorCode =
  | "subscription-provider-not-supported"
  | "subscription-runtime-not-configured"
  | "subscription-runtime-unavailable"
  | "subscription-runtime-unsafe-location"
  | "subscription-runtime-unsafe-npm-location"
  | "subscription-runtime-version-unsupported"
  | "subscription-runtime-incompatible"
  | "subscription-login-in-progress"
  | "subscription-login-failed"
  | "subscription-verification-url-unavailable"
  | "subscription-logout-not-supported"
  | "subscription-chat-unavailable"
  | "subscription-operation-failed";

export type SubscriptionRuntimeActionResult =
  | { ok: true; status: SubscriptionRuntimeStatus }
  | {
      ok: false;
      error: SubscriptionRuntimeErrorCode;
      status?: SubscriptionRuntimeStatus;
    };

export type SubscriptionRuntimeModelsResult =
  | {
      ok: true;
      status: SubscriptionRuntimeStatus;
      models: SubscriptionRuntimeModel[];
    }
  | {
      ok: false;
      error: SubscriptionRuntimeErrorCode;
      status?: SubscriptionRuntimeStatus;
    };
