/** Subscription runtimes own credentials and stateful transport; keep their settings, pricing, and execution assumptions separate from API-key vendors. */
import { CLAUDE_CODE_CLI_MINIMUM_VERSION } from "./claude-code-subscription.js";
import { CODEX_CLI_MINIMUM_VERSION } from "./codex-subscription.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "./safe-integer.js";

const SUBSCRIPTION_RUNTIME_IDS = ["codex", "kimi-code", "grok-build", "claude-code", "chatgpt-plan"] as const;

export type SubscriptionRuntimeId = (typeof SUBSCRIPTION_RUNTIME_IDS)[number];
export const MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH = 200;

/** The loopback bridge and shim share wire bounds and environment keys so neither accepts payloads the other refuses. */
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

export function isSubscriptionToolDescription(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxDescriptionBytes
    && !/[\u0000\u007f]/.test(value)
    && new TextEncoder().encode(value).byteLength <= SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxDescriptionBytes;
}

/** Mint and validate bridge tool names with the same bounded grammar; nonconforming host names become ave_<sha>. */
const SUBSCRIPTION_BRIDGE_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

export function isSubscriptionBridgeToolName(name: unknown): name is string {
  return typeof name === "string" && SUBSCRIPTION_BRIDGE_TOOL_NAME_PATTERN.test(name);
}

/** Local estimates must never appear as provider-reported usage; subscription consumption is separate from billable API usage. */
export type SubscriptionUsageSource = "provider-reported" | "local-estimate";

/** Exact provider totals or estimated input/output sums are never API price inputs; preserve billable:false across persistence and IPC. */
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

/** Reject unknown telemetry fields and rebuild the projection so raw provider payloads cannot cross into the renderer. */
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

/** Invalidation events carry only a revision; re-read safe status without exposing URLs, paths, credentials, or provider output. */
export interface SubscriptionRuntimeStatusUpdatedEvent {
  readonly provider: SubscriptionRuntimeId;
  readonly revision: number;
}

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

/** `chatgpt-plan-direct` is Sign in with ChatGPT plan usage: Ave's own OAuth session and `POST /v1/responses`, no CLI. */
type SubscriptionRuntimeTransport = "codex-app-server" | "acp" | "claude-cli" | "chatgpt-plan-direct";

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

/** Model selection is optional because a runtime may expose only its own default. */
export interface SubscriptionChatRuntimeSelection {
  kind: "subscription";
  provider: SubscriptionRuntimeId;
  model?: string;
}

/** Only runtimes with host-verified model selection honor per-call overrides. */
export function subscriptionAcceptsModelOverride(selection: SubscriptionChatRuntimeSelection): boolean {
  return selection.provider === "codex";
}

interface ApiChatRuntimeSelection {
  kind: "api";
}

export type ActiveChatRuntime = ApiChatRuntimeSelection | SubscriptionChatRuntimeSelection;

/** Discovered runtimes use installed CLI locations; user-selected runtimes allow an executable picker; `none` runs no executable. */
export type SubscriptionRuntimeExecutableSource = "discovered" | "user-selected" | "none";

export interface SubscriptionRuntimeDescriptor {
  id: SubscriptionRuntimeId;
  label: string;
  planName: string;
  cliName: string;
  transport: SubscriptionRuntimeTransport;
  executable: SubscriptionRuntimeExecutableSource;
  loginMethods: readonly SubscriptionLoginMethod[];
  supportsManagedLogout: boolean;
  /** Only surface a picker when the runtime supplies a trustworthy model list. */
  supportsModelSelection: boolean;
  minimumVersion?: string;
  installGuidance?: SubscriptionRuntimeInstallGuidance;
  /** No model selection uses the runtime default, offered explicitly rather than guessed as a model name. */
  offersCliDefaultModel: boolean;
  /** The runtime has no default model at all: chat can be selected only with a model from its list. */
  requiresModelSelection?: true;
  /** Where the provider lets the user review and limit this app's plan usage. */
  usageSettingsUrl?: string;
  /**
   * Original images are sent only when the selected model accepts them, judged by this API vendor's model catalog
   * (the same predicate as that vendor's API-key route). Absent: the runtime's verified capability alone decides.
   */
  imageInputFollowsModelOf?: "openai";
  /**
   * The runtime runs on Ave's own request path, so Ave chooses its reasoning: the user picks a speed
   * (`SUBSCRIPTION_REASONING_SPEEDS`) and each turn asks the model for that speed's effort.
   */
  offersReasoningSpeed?: true;
}

/** The model speed menu of a runtime that `offersReasoningSpeed`, fastest first, as the provider's own app labels it. */
export const SUBSCRIPTION_REASONING_SPEEDS = Object.freeze(["instant", "medium", "high"] as const);
export type SubscriptionReasoningSpeed = (typeof SUBSCRIPTION_REASONING_SPEEDS)[number];
/** The provider's own app opens on Medium. */
export const DEFAULT_SUBSCRIPTION_REASONING_SPEED: SubscriptionReasoningSpeed = "medium";

export function isSubscriptionReasoningSpeed(value: unknown): value is SubscriptionReasoningSpeed {
  return typeof value === "string" && (SUBSCRIPTION_REASONING_SPEEDS as readonly string[]).includes(value);
}

/**
 * The reasoning effort a speed asks for. The model's own accepted levels still decide what is sent: a model that
 * refuses `none` runs Instant at its lowest accepted level, and the speed menu says so.
 */
export function subscriptionReasoningSpeedEffort(speed: SubscriptionReasoningSpeed): "none" | "medium" | "high" {
  switch (speed) {
    case "instant":
      return "none";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default: {
      const unknownSpeed: never = speed;
      throw new Error(`unknown reasoning speed: ${String(unknownSpeed)}`);
    }
  }
}

/** Install instructions are display text; the app never executes them. */
export interface SubscriptionRuntimeInstallGuidance {
  readonly documentationUrl: string;
  readonly commands: readonly { readonly label: string; readonly command: string }[];
}

/** Only host-verified capabilities using governed permission, audit, project, and lifecycle paths may be true; absent projections remain unknown. */
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
  /** The negotiated original-image budget is separate from file-marker and governed read-tool support. */
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

/** Join subscription runtimes to API routes by existing vendor IDs; omit runtimes with no key-based route. */
export const SUBSCRIPTION_RUNTIME_API_COUNTERPART: Readonly<
  Partial<Record<SubscriptionRuntimeId, string>>
> = Object.freeze({
  codex: "openai",
  "claude-code": "claude",
  "grok-build": "xai",
  "kimi-code": "moonshot",
});

/**
 * Runtimes that are another way into a provider row already owned by a primary runtime. ChatGPT plan usage is the
 * third OpenAI sign-in beside the Codex CLI and the API key, so it joins the Codex row instead of adding a second
 * "OpenAI" row.
 */
export const SUBSCRIPTION_RUNTIME_ROW_PARTNER: Readonly<
  Partial<Record<SubscriptionRuntimeId, SubscriptionRuntimeId>>
> = Object.freeze({
  "chatgpt-plan": "codex",
});

/** The three ways chat reaches OpenAI. Exactly one is in effect, chosen by the persisted `activeChatRuntime`. */
export type OpenAiLoginType = "codex-cli" | "api-key" | "chatgpt-plan";

/**
 * Which OpenAI login type a subscription runtime is, or null for another company's runtime. Exhaustive over
 * `SubscriptionRuntimeId`: adding a runtime is a compile error here until it is classified.
 */
export function openAiLoginTypeOfRuntime(
  runtimeId: SubscriptionRuntimeId,
): Exclude<OpenAiLoginType, "api-key"> | null {
  switch (runtimeId) {
    case "codex":
      return "codex-cli";
    case "chatgpt-plan":
      return "chatgpt-plan";
    case "kimi-code":
    case "grok-build":
    case "claude-code":
      return null;
    default: {
      const unclassified: never = runtimeId;
      throw new Error(`unclassified subscription runtime: ${String(unclassified)}`);
    }
  }
}

/**
 * Name the OpenAI sign-in a chat selection uses, or null when chat is not on OpenAI. This is derived from the one
 * persisted selection (`activeChatRuntime` plus the API vendor), never stored separately, so the two cannot disagree:
 * `{kind:"subscription", provider:"codex"}` is the Codex CLI, `{kind:"subscription", provider:"chatgpt-plan"}` is
 * plan usage, and `{kind:"api"}` with vendor `openai` is the API key. Settings saved before plan usage existed hold
 * one of the first two shapes and so keep their sign-in.
 */
export function openAiLoginTypeFor(
  runtime: ActiveChatRuntime | undefined,
  apiVendor: string | undefined,
): OpenAiLoginType | null {
  if (runtime?.kind === "subscription") return openAiLoginTypeOfRuntime(runtime.provider);
  return apiVendor === "openai" ? "api-key" : null;
}

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

/**
 * Whether a CLI `version` is at least `minimum` (both `major.minor.patch`). A pre-release of the minimum is below it; `+build` metadata is ignored, as in
 * semantic versioning. Unparseable input is below every minimum.
 */
export function meetsMinimumCliVersion(version: string, minimum: string): boolean {
  const parse = (value: string) => {
    const [core, prerelease] = value.replace(/\+.*$/su, "").split(/-(.*)/s, 2) as [string, string | undefined];
    return { parts: core.split(".").map((part) => Number(part)), prerelease: prerelease !== undefined };
  };
  const found = parse(version);
  const required = parse(minimum);
  if (found.parts.length !== 3 || found.parts.some((part) => !Number.isSafeInteger(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = found.parts[index]! - (required.parts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return !found.prerelease || required.prerelease;
}

export const SUBSCRIPTION_RUNTIME_DESCRIPTORS: readonly SubscriptionRuntimeDescriptor[] = [
  {
    id: "codex",
    label: "Codex",
    planName: "ChatGPT",
    cliName: "Codex CLI",
    transport: "codex-app-server",
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
    offersCliDefaultModel: false,
  },
  {
    id: "chatgpt-plan",
    label: "ChatGPT plan",
    planName: "ChatGPT",
    // No CLI is involved; the name the card shows for this way in.
    cliName: "Sign in with ChatGPT",
    transport: "chatgpt-plan-direct",
    executable: "none",
    loginMethods: ["browser"],
    supportsManagedLogout: true,
    // The account's own `GET /v1/models` list; there is no runtime default to fall back on.
    supportsModelSelection: true,
    offersCliDefaultModel: false,
    requiresModelSelection: true,
    usageSettingsUrl: "https://chatgpt.com/settings/usage",
    imageInputFollowsModelOf: "openai",
    offersReasoningSpeed: true,
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
    offersCliDefaultModel: false,
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
    offersCliDefaultModel: false,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    planName: "Claude",
    cliName: "Claude Code CLI",
    transport: "claude-cli",
    executable: "discovered",
    loginMethods: ["browser"],
    supportsManagedLogout: true,
    // No model selection leaves the CLI on its default; selected IDs come from provider models.
    supportsModelSelection: true,
    offersCliDefaultModel: true,
    minimumVersion: CLAUDE_CODE_CLI_MINIMUM_VERSION,
    installGuidance: Object.freeze({
      documentationUrl: "https://code.claude.com/docs/en/setup",
      commands: Object.freeze([
        Object.freeze({ label: "macOS / Linux", command: "curl -fsSL https://claude.ai/install.sh | bash" }),
        Object.freeze({ label: "Windows (PowerShell)", command: "irm https://claude.ai/install.ps1 | iex" }),
        Object.freeze({ label: "Homebrew", command: "brew install --cask claude-code" }),
        Object.freeze({ label: "WinGet", command: "winget install Anthropic.ClaudeCode" }),
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
 * Something the user should be told about a runtime's sign-in, until they dismiss it (ChatGPT plan usage only today).
 * `welcome`: the first sign-in with plan usage enabled. `plan-usage-disabled`: signed in without the plan grant.
 * `reconnect-required`: the session ended at the provider. `revocation-unconfirmed`: signed out locally but the
 * provider did not confirm it. `declined`, `account-mismatch`, `state-mismatch`, `sign-in-failed`: why the last
 * sign-in did not finish.
 */
export type SubscriptionRuntimeNotice =
  | "welcome"
  | "plan-usage-disabled"
  | "reconnect-required"
  | "revocation-unconfirmed"
  | "declined"
  | "account-mismatch"
  | "state-mismatch"
  | "sign-in-failed";

/** Never include verification URLs, access tokens, raw CLI output, or executable paths in renderer status. */
export interface SubscriptionRuntimeStatus {
  provider: SubscriptionRuntimeId;
  runtime: SubscriptionRuntimeState;
  connection: SubscriptionConnectionState;
  planType: string | null;
  pendingLogin: SubscriptionLoginMethod | null;
  pendingDeviceCode: string | null;
  canOpenVerificationUrl: boolean;
  version: string | null;
  /** Missing or false capability projections are unavailable; provider-native claims alone do not enable them. */
  capabilities: SubscriptionRuntimeCapabilities;
  /** A fixed notice code for the card; omitted by runtimes that have none. */
  notice?: SubscriptionRuntimeNotice | null;
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
  | "subscription-runtime-native-required"
  | "subscription-runtime-unauthenticated"
  | "subscription-runtime-release-metadata-unavailable"
  | "subscription-runtime-version-unsupported"
  | "subscription-runtime-incompatible"
  | "subscription-login-in-progress"
  | "subscription-login-failed"
  | "subscription-verification-url-unavailable"
  | "subscription-logout-not-supported"
  | "subscription-chat-unavailable"
  | "subscription-model-not-supported"
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
