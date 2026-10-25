/** Every staged origin requires a provenance envelope and remains untrusted. On disagreement, send rejects, stream recovery adopts the envelope, and direct turns keep the claim; no boundary may resolve downward in trust. */
import type { ChatInputOrigin, StagedChatInputOrigin } from "./chat-origin.js";
import { type FenceTag, neutralizeFenceClose } from "./fence-sanitizer.js";
import { stripLeadingSlash } from "./slash-sanitizer.js";

export interface StagedOriginKind {
  /** Keep this type restricted to staged send origins so registration cannot widen the send gate to another origin kind. */
  readonly inputOrigin: StagedChatInputOrigin;
  readonly fenceTag: FenceTag;
  readonly sourcePattern: RegExp;
  /** Register model guidance alongside the force-ask gate so neither can omit a staged origin. */
  readonly guidance: {
    readonly tag: string;
    /** Ordered i18n keys; the FIRST one receives the `{source}` placeholder. */
    readonly lineKeys: readonly string[];
  };
  readonly labelKey: string;
  /** Keep explicit IPC rejection codes aligned with renderer error localization. */
  readonly missingEnvelopeError: string;
  /** Envelope prefix matcher — capture group 1 is the source tag. */
  readonly envelopePrefixPattern: RegExp;
  /** Full-envelope matcher — group 1 source, group 2 body. */
  readonly envelopeFullPattern: RegExp;
}

/** Anchor and bound sources; keep body matching greedy without adjacent whitespace quantifiers to avoid superlinear failure on unclosed whitespace bodies. */
function envelopePatterns(fenceTag: string, sourceBody: string): {
  prefix: RegExp;
  full: RegExp;
} {
  return {
    prefix: new RegExp(`^<${fenceTag}\\s+source="(${sourceBody})"\\s*>`),
    full: new RegExp(
      `^<${fenceTag}\\s+source="(${sourceBody})"\\s*>([\\s\\S]*)</${fenceTag}>\\s*$`,
    ),
  };
}

const OVERLAY_SOURCE_BODY = "overlay:[a-z][a-z0-9-]*";
const APP_SOURCE_BODY = "app:[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const MCP_PROMPT_SOURCE_BODY = "mcp-prompt:[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const PLUGIN_PROMPT_SOURCE_BODY = "plugin-prompt:(?:extension:)?[a-z][a-z0-9-]{0,62}:[a-z][a-z0-9-]{0,62}";

const overlayEnvelope = envelopePatterns("imported-from-proactive", OVERLAY_SOURCE_BODY);
const appEnvelope = envelopePatterns("app-message", APP_SOURCE_BODY);
const mcpPromptEnvelope = envelopePatterns("mcp-prompt", MCP_PROMPT_SOURCE_BODY);
const pluginPromptEnvelope = envelopePatterns("plugin-prompt", PLUGIN_PROMPT_SOURCE_BODY);

/** The registry is total over StagedChatInputOrigin; namespaces are disjoint and lookup order is irrelevant. */
const STAGED_ORIGINS: Readonly<Record<StagedChatInputOrigin, StagedOriginKind>> = Object.freeze({
  "plugin-emitted": Object.freeze({
    inputOrigin: "plugin-emitted",
    labelKey: "trustOriginLabel.pluginEmitted",
    fenceTag: "imported-from-proactive",
    sourcePattern: new RegExp(`^${OVERLAY_SOURCE_BODY}$`),
    guidance: {
      tag: "overlay-trigger-origin-guidance",
      lineKeys: [
        "be_systemPromptBuilder.overlayTriggerOriginNotDirectInput",
        "be_systemPromptBuilder.overlayTriggerOriginPluginSuggestion",
        "be_systemPromptBuilder.overlayTriggerOriginValidateFirst",
        "be_systemPromptBuilder.overlayTriggerOriginCheckTimeliness",
        "be_systemPromptBuilder.overlayTriggerOriginCheckContextConflict",
        "be_systemPromptBuilder.overlayTriggerOriginCheckHallucination",
        "be_systemPromptBuilder.overlayTriggerOriginPassIfInvalid",
        "be_systemPromptBuilder.overlayTriggerOriginProceedIfValid",
      ],
    },
    missingEnvelopeError: "missing-plugin-envelope",
    envelopePrefixPattern: overlayEnvelope.prefix,
    envelopeFullPattern: overlayEnvelope.full,
  } as const),
  "app-emitted": Object.freeze({
    inputOrigin: "app-emitted",
    labelKey: "trustOriginLabel.appEmitted",
    fenceTag: "app-message",
    sourcePattern: new RegExp(`^${APP_SOURCE_BODY}$`),
    guidance: {
      tag: "app-message-origin-guidance",
      lineKeys: [
        "be_systemPromptBuilder.appMessageOriginNotDirectInput",
        "be_systemPromptBuilder.appMessageOriginUntrusted",
        "be_systemPromptBuilder.appMessageOriginConfirmBeforeAction",
      ],
    },
    missingEnvelopeError: "missing-app-envelope",
    envelopePrefixPattern: appEnvelope.prefix,
    envelopeFullPattern: appEnvelope.full,
  } as const),
  "mcp-prompt-emitted": Object.freeze({
    inputOrigin: "mcp-prompt-emitted",
    labelKey: "trustOriginLabel.mcpPromptEmitted",
    fenceTag: "mcp-prompt",
    sourcePattern: new RegExp(`^${MCP_PROMPT_SOURCE_BODY}$`),
    guidance: {
      tag: "mcp-prompt-origin-guidance",
      lineKeys: [
        "be_systemPromptBuilder.mcpPromptOriginNotDirectInput",
        "be_systemPromptBuilder.mcpPromptOriginServerAuthored",
        "be_systemPromptBuilder.mcpPromptOriginConfirmBeforeAction",
      ],
    },
    missingEnvelopeError: "missing-mcp-prompt-envelope",
    envelopePrefixPattern: mcpPromptEnvelope.prefix,
    envelopeFullPattern: mcpPromptEnvelope.full,
  } as const),
  "plugin-prompt-emitted": Object.freeze({
    inputOrigin: "plugin-prompt-emitted",
    labelKey: "trustOriginLabel.pluginPromptEmitted",
    fenceTag: "plugin-prompt",
    sourcePattern: new RegExp(`^${PLUGIN_PROMPT_SOURCE_BODY}$`),
    guidance: {
      tag: "plugin-prompt-origin-guidance",
      lineKeys: [
        "pluginPromptOrigin.notDirectInput",
        "pluginPromptOrigin.packageAuthored",
        "pluginPromptOrigin.confirmBeforeAction",
      ],
    },
    missingEnvelopeError: "missing-plugin-prompt-envelope",
    envelopePrefixPattern: pluginPromptEnvelope.prefix,
    envelopeFullPattern: pluginPromptEnvelope.full,
  } as const),
});

export const STAGED_ORIGIN_KINDS: readonly StagedOriginKind[] = Object.freeze(
  Object.values(STAGED_ORIGINS),
);

export function stagedOriginFor(inputOrigin: StagedChatInputOrigin): StagedOriginKind {
  return STAGED_ORIGINS[inputOrigin];
}

export function stagedOriginForInput(
  inputOrigin: ChatInputOrigin | string | null | undefined,
): StagedOriginKind | undefined {
  if (!inputOrigin) return undefined;
  return STAGED_ORIGIN_KINDS.find((kind) => kind.inputOrigin === inputOrigin);
}

/** Derive runtime send-origin membership from the registry so type widening cannot leave a stale guard. */
export function isStagedSendOrigin(value: unknown): boolean {
  return STAGED_ORIGIN_KINDS.some((kind) => kind.inputOrigin === value);
}

export function stagedOriginForSource(
  source: string | null | undefined,
): StagedOriginKind | undefined {
  if (typeof source !== "string") return undefined;
  return STAGED_ORIGIN_KINDS.find((kind) => kind.sourcePattern.test(source));
}

/** Permission gates and model guidance share this force-ask predicate. */
export function isStagedTurnSource(source: string | null | undefined): boolean {
  return stagedOriginForSource(source) !== undefined;
}

export function isMissingStagedEnvelopeErrorMessage(value: unknown): boolean {
  return typeof value === "string"
    && STAGED_ORIGIN_KINDS.some((kind) => kind.missingEnvelopeError === value);
}

export interface StagedEnvelope {
  kind: StagedOriginKind;
  source: string;
  body: string;
}

/** Reject invalid source tags; strip leading slashes and neutralize body closing tags so staged text cannot dispatch commands or escape provenance. */
export function formatStagedEnvelope(
  kind: StagedOriginKind,
  text: string,
  source: string,
): string {
  if (!kind.sourcePattern.test(source)) {
    throw new Error(`invalid ${kind.fenceTag} source: ${source}`);
  }
  const body = neutralizeFenceClose(stripLeadingSlash(text), kind.fenceTag);
  return `<${kind.fenceTag} source="${source}">\n${body}\n</${kind.fenceTag}>`;
}

export function parseStagedEnvelope(
  input: string,
): { kind: StagedOriginKind; source: string } | null {
  const trimmed = input.trimStart();
  for (const kind of STAGED_ORIGIN_KINDS) {
    const match = trimmed.match(kind.envelopePrefixPattern);
    if (match) return { kind, source: match[1] };
  }
  return null;
}

/** Check the bounded prefix and closing suffix before matching the body; imported unclosed envelopes must not reach expensive quantifiers. */
export function parseStagedEnvelopePayload(input: string): StagedEnvelope | null {
  const trimmed = input.trim();
  const prefix = parseStagedEnvelope(trimmed);
  if (!prefix) return null;
  if (trimmed.endsWith(`</${prefix.kind.fenceTag}>`)) {
    const full = trimmed.match(prefix.kind.envelopeFullPattern);
    if (full) return { kind: prefix.kind, source: full[1], body: full[2].trim() };
  }
  // An unclosed header still identifies provenance; callers requiring closed envelopes must verify the closing tag themselves.
  return {
    kind: prefix.kind,
    source: prefix.source,
    body: trimmed.replace(prefix.kind.envelopePrefixPattern, "").trim(),
  };
}
