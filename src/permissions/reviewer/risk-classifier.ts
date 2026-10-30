import { isDestructiveShellArgv, noReusableRuleReason } from "../rules/shell-prefix-values.js";
// Disabled mode yields LOW while mandatory gates still apply. Model review composes conservatively with deterministic evidence and redacts provider input.
import type { ToolCategory, ToolSource, ToolTrustOrigin } from "../../tools/types.js";
import { isIP } from "node:net";
import { maskSensitiveData, scrubSecretsForLLM } from "../../audit/dlp-filter.js";
import { isGloballyRoutableAddress } from "../../core/network-guard.js";
import { PERMISSION_REVIEWER_SYSTEM_PROMPT } from "../../shared/permission-reviewer-framework.js";
import { selectDeclaredPathValues } from "../../shared/dotted-field-value.js";
import { extractShellCommands } from "../../shared/shell-command-fields.js";
import { stripCommandPath, tokenizeShell, type ShellLeaf } from "../../shared/shell-tokenizer.js";
import {
  isReadOnlyShellLeaf,
  longOptionAbbreviates,
  namesProgramToRun,
  shortClusterHas,
} from "./host-risk-inspector.js";
import {
  formatSandboxCapabilityForPrompt,
  isDisposableSubstrateCapability,
  sandboxRelaxesCategory,
  type SandboxCapability,
} from "../sandbox-capability.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../sensitive-paths.js";
import { isPathAllowed } from "../allowed-directories.js";
import {
  extractNetworkTarget,
  NETWORK_TARGET_FIELDS,
  type NetworkTarget,
} from "./network-target.js";
import { resolveToolPathForPermission } from "../../shared/tool-path-resolution.js";
import type { RiskLevel } from "../../shared/permission-review-status.js";
import { resolve as resolvePath } from "node:path";
import { SHELL_EXFIL_VERDICT_REASON } from "../rules/shell-exfiltration.js";
import { shellExfiltrationSignal, inspectShellCommand } from "../rules/literal-shell-inspection.js";
import { powerShellExfiltrationSignal, inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { isBrowserToolName, isBrowserUrlToolName } from "../../shared/browser-tools.js";
import { reviewUserOwnedSurface, type UserOwnedSurfaceReviewInput, type UserOwnedSurfaceReviewResult } from "./user-owned-surface-reviewer.js";

// Verdict shape returned by every classifier.
export interface RiskVerdict {
  level: RiskLevel;
  reason: string;
  // Unknown effects require a human even when their display risk permits remembering the answer. Keep explicit approval on its own axis so lowering below HIGH cannot also enable foreground auto-approval through another authority.
  requiresExplicitApproval?: boolean;
}

export interface LlmRiskClassificationTrace {
  ruleVerdict: RiskVerdict;
  llmVerdict: RiskVerdict | null;
  finalVerdict: RiskVerdict;
  outcome: "fresh" | "host-determined" | "error" | "timeout" | "malformed";
}
export type ReviewerDispatchErrorCode = "timeout" | "error";

export class ReviewerDispatchError extends Error {
  constructor(
    readonly code: ReviewerDispatchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReviewerDispatchError";
  }
}

function reviewerFailureOutcome(error: unknown): "timeout" | "error" {
  if (error instanceof ReviewerDispatchError) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "error";
}

// Numeric ordering for `final = max(rule, llm)`.
const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

// Pick the higher-rank verdict. Ties prefer `b` (LLM) for reason text.
export function maxVerdict(a: RiskVerdict, b: RiskVerdict): RiskVerdict {
  return LEVEL_RANK[b.level] >= LEVEL_RANK[a.level] ? b : a;
}

// Classify raw finalized input identically in every lane; DLP can destroy URL/path policy signals. Mask provider, display, audit and deferred sinks instead so secrets never leave through them.
export interface ToolInvocationContext {
  toolName: string;
  // Host policy reason from the original decision, never reconstructed from arguments.
  permissionReason?: string;
  source: ToolSource;
  category: ToolCategory;
  // Manifest-declared path-bearing argument selectors. Dotted selectors are supported.
  pathFields: readonly string[];
  // Permission policy trust origin. Surfaced in the LLM prompt so the classifier can reason about prompt-injection risk: an `llm-tool-arg` write of the same shape as a `user-keyboard` write is meaningfully different.
  trustOrigin: ToolTrustOrigin;
  finalInput: Record<string, unknown>;
  // The cwd the tool will actually execute against — the SAME value the enforcer resolves path arguments with (`extractTargetFilePaths(tool, finalInput, executionCwd)`). REQUIRED, deliberately: this is the second half of resolveToolPathForPermission's contract, and an optional field with a `process.cwd` fallback is exactly the divergence this replaced — the reviewer would silently judge a different file than Layer 1 checks. Making it required means the compiler, not a code reviewer, catches a producer that forgets to thread it.
  executionCwd: string;
  allowedDirectories: string[];
  // Adjacent sensitive entries (e.g. `.env`, `.git`) detected near the path.
  sensitivePathsAdjacent: string[];
  // OS-level execution sandbox capability — the reviewer SOT for issue. Constructed by resolveReviewerSandboxCapability at the dispatch site (single producer) and threaded here so the LLM prompt sees the same value used by the reviewer. The current audit schema records the resulting reviewer verdict, not the full SandboxCapability snapshot. Required: callers MUST supply it so a missing field cannot silently downgrade the reviewer's safety posture.
  sandboxCapability: SandboxCapability;
  // Conversation context for context-quality no-downgrade rule. Only `recentUserMessage` is consulted — the heuristic in isContextMissingIntent treats an absent or short (<5 chars) message as "weak context", preventing the LLM from downgrading a rule-based MEDIUM/HIGH verdict to LOW. Optional so that existing callers do not require immediate updates. Absence is treated as weak context (conservative).
  conversationContext?: {
    recentUserMessage?: string;
  };
  // Only the host-computed plugin DATA root plus verified containment earns sandbox-write LOW; never trust manifest attestations or permit bundle-root self-rewrites. Include the root in cache identity and leave it absent for unqualified tools.
  ownerPluginSandboxRoot?: string;
}

export interface RiskClassifier {
  classify(input: ToolInvocationContext): RiskVerdict | Promise<RiskVerdict>;
  reviewUserOwnedSurface?(input: UserOwnedSurfaceReviewInput, signal?: AbortSignal): Promise<UserOwnedSurfaceReviewResult>;
}

// DisabledRiskClassifier

// Disabling automatic review leaves mandatory gates and permission rules in force.
export class DisabledRiskClassifier implements RiskClassifier {
  classify(_: ToolInvocationContext): RiskVerdict {
    return { level: "low", reason: "reviewer disabled — pass-through" };
  }
}

// Context-quality helpers

// Require all intent signals: at least 15 graphemes, three distinct words of two or more characters, and 0.25 character diversity. Any failure means missing intent and blocks model downgrades; graphemes preserve non-Latin text semantics.
export function isContextMissingIntent(input: ToolInvocationContext): boolean {
  const msg = input.conversationContext?.recentUserMessage?.trim() ?? "";
  if (msg.length === 0) return true;

  // Signal 1: grapheme cluster count (CJK-safe)
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = Array.from(segmenter.segment(msg)).length;
  if (graphemes < 15) return true;

  // Signal 2: unique word count (whitespace-split, min length 2)
  const words = new Set(
    msg.toLowerCase().split(/\s+/).filter((w) => w.length >= 2),
  );
  if (words.size < 3) return true;

  // Signal 3: character diversity ratio (entropy proxy)
  const uniqueChars = new Set(msg).size;
  const diversityRatio = uniqueChars / msg.length;
  if (diversityRatio < 0.25) return true;

  return false;
}

// RuleBasedRiskClassifier 36-combination heuristic. Each rule is a pure function that returns either a verdict or `null` to fall through. Order matters: more specific verbs/domains run first; the catch-all default is MEDIUM (fail-safe — never downgrade an unknown shape to LOW).

// Destructive shell verbs (HIGH). Word-boundary match so `rmdir` is caught and `farmer` is not.
const DESTRUCTIVE_SHELL_RE = new RegExp([
  String.raw`\brm\s+-r`,
  String.raw`\brm\s+-f`,
  String.raw`\brm\s+-rf`,
  String.raw`\bsudo\b`,
  String.raw`\bcurl[^|]*\|\s*sh`,
  String.raw`\bwget[^|]*\|\s*sh`,
  String.raw`\bdd\s+if=`,
  String.raw`\bmkfs\b`,
  String.raw`\bchmod\s+777`,
  String.raw`\bRemove-Item\b[^\n\r;|&]*\s-(?:Recurse|Force)\b`,
  String.raw`\brmdir\b[^\n\r;|&]*/s\b`,
  String.raw`\brd\b[^\n\r;|&]*/s\b`,
  String.raw`\bdel\b[^\n\r;|&]*/s\b`,
].join("|"), "i");

// Shared floor test for the permission rules matcher: a command text the rule classifier grades destructive can never be covered by an allow rule. One regex, one owner — the matcher must not keep a second list.
export function isDestructiveShellText(command: string): boolean {
  return DESTRUCTIVE_SHELL_RE.test(command);
}

// The directory a shell invocation's relative paths resolve against.
function shellInvocationCwd(ctx: ToolInvocationContext): string | undefined {
  const requested = ctx.finalInput.cwd;
  if (typeof requested === "string" && requested.length > 0) {
    return ctx.executionCwd ? resolvePath(ctx.executionCwd, requested) : requested;
  }
  return ctx.executionCwd || undefined;
}

// Reversible shell verbs (LOW). Read-only or trivially undoable.
const REVERSIBLE_SHELL_RE =
  /^\s*(echo|touch|ls|cat|pwd|whoami|date|env|true|false)\b/i;

// Hosts the host considers trusted by virtue of being Ave-owned or canonical model providers. `network → trusted-host` collapses to LOW. Exact-match set for well-known fixed hostnames. For hosts that appear as subdomains (e.g. Azure AI Foundry project endpoints), use the suffix list below.
const TRUSTED_NETWORK_HOSTS: ReadonlySet<string> = new Set([
  "ave.agent-connector.ai",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
]);

// Trusted hostname suffixes — any hostname that ends with one of these patterns (and the suffix is preceded by a `.` or IS the full hostname) is considered trusted. Used for Azure endpoints whose project subdomain varies per user (`<project>.services.ai.azure.com`, `<resource>.openai.azure.com`, etc.). Subdomain takeover analysis: both suffixes are rooted at `.azure.com`, which Microsoft controls. A dangling-CNAME attack would require an attacker to claim the exact Azure resource in the user's subscription — not feasible without the user's subscription credentials. See also validateFoundryEndpoint in foundry-endpoint.ts.
export const TRUSTED_NETWORK_HOST_SUFFIXES: readonly string[] = [
  ".services.ai.azure.com",
  ".openai.azure.com",
];

// Returns true when `host` is in TRUSTED_NETWORK_HOSTS (exact) or ends with one of TRUSTED_NETWORK_HOST_SUFFIXES (suffix).
function isTrustedNetworkHost(host: string): boolean {
  if (TRUSTED_NETWORK_HOSTS.has(host)) return true;
  for (const suffix of TRUSTED_NETWORK_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  return false;
}

// Localhost / loopback variants.
const LOCALHOST_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
]);

function extractNetworkHost(input: Record<string, unknown>): string | null {
  return extractNetworkTarget(input)?.host ?? null;
}

// The one builtin whose network verdict the request screen below owns.
const SCREENED_EGRESS_TOOL = "web_fetch";

// Longest `path + query + fragment` a fetch of a document is expected to carry. Chosen well above ordinary deep links and doc anchors (~100-200 chars) and well below what it takes to carry a useful amount of text in a URL. A tail past this is not a way to name a page.
const EXFIL_URL_TAIL_MAX_CHARS = 512;

// Shortest opaque run treated as carried DATA rather than as a name.
const EXFIL_BLOB_MIN_CHARS = 32;

// Characters a base64 / base64url / hex encoded blob is made of.
const EXFIL_BLOB_ALPHABET_RE = /^[A-Za-z0-9+/=_-]+$/;

// Longest unbroken alphanumeric run in a span. This is what separates a NAME from a BLOB where the two share an alphabet. A slug is words joined by separators, so its longest run is one word: `how-to-configure-your-database-connection` runs 10. An encoded payload is one token: a commit hash runs 40, standard base64 runs the whole length. Measured instead of Shannon entropy, which does not separate the two at all — that slug scores 3.89 bits/char and a hash scores 3.97, so any threshold admitting one admits the other. Reading a documentation page must not raise an approval, and this rule is the reason it does not.
function longestAlphanumericRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const ch of value) {
    if (/[A-Za-z0-9]/.test(ch)) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

// A path segment or hostname label that is one long opaque token — a name nobody wrote. Strict about separators because this is where legitimate names live: page slugs, package names, doc anchors. Only an unbroken run counts.
function isOpaqueNameToken(token: string): boolean {
  if (token.length < EXFIL_BLOB_MIN_CHARS) return false;
  if (!EXFIL_BLOB_ALPHABET_RE.test(token)) return false;
  return longestAlphanumericRun(token) >= EXFIL_BLOB_MIN_CHARS;
}

// A query value or fragment long enough to be a payload. Looser than isOpaqueNameToken, deliberately: a query value is a VALUE, and nothing a person reads needs 32 opaque characters of one, so the separator allowance a slug earns does not apply here. This is what catches base64url, whose own alphabet includes `-` and `_` and which therefore carries separators of its own.
function isCarriedValueBlob(value: string): boolean {
  if (value.length < EXFIL_BLOB_MIN_CHARS) return false;
  return EXFIL_BLOB_ALPHABET_RE.test(value);
}

// Screen opaque runs in host/path names and encoded length in query names/values/fragments. Split sub-threshold chunks or mixed alphabets can evade this per-request screen; oversized-tail limits, no standing allows and no unattended lane remain necessary.
function carriesOpaquePayload(target: NetworkTarget): boolean {
  const labels = target.host.split(".");
  if (labels.some(isOpaqueNameToken)) return true;
  const segments = target.path.split("/").filter((segment) => segment.length > 0);
  if (segments.some(isOpaqueNameToken)) return true;
  for (const [name, value] of new URLSearchParams(target.query)) {
    if (isCarriedValueBlob(value) || isCarriedValueBlob(name)) return true;
  }
  const fragment = target.fragment.replace(/^#/, "");
  return isCarriedValueBlob(fragment);
}

// Is `host` an address literal, and if so does it name somewhere outside this machine and this network? Bracketed IPv6 authorities are unwrapped first. A NAME is never an address literal: the host cannot resolve one without blocking, and the SSRF guard resolves it per hop later anyway.
function classifyAddressLiteral(host: string): { literal: boolean; routable: boolean } {
  const bare = host.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(bare) === 0) return { literal: false, routable: false };
  return { literal: true, routable: isGloballyRoutableAddress(bare) };
}

// Machine-readable prefix every escalated fetch verdict shares.
export const EXFIL_VERDICT_REASON_PREFIX = "network possible exfiltration";

// Verdict reason for a screened-clean public destination.
export const PUBLIC_FETCH_REASON = "network public host (screened)";

// Verdict reason for a public destination named by address rather than name.
export const PUBLIC_RAW_IP_FETCH_REASON = "network public raw ip";

// Why one fetch was escalated. Stable codes; the renderer localizes them.
export type EgressScreenSignal =
  | "url-userinfo"
  | "credential-in-url"
  | "oversized-url-tail"
  | "high-entropy-blob";

// What the host concluded about one fetch, before any policy reads it. `not-public` is an abstention, not a clearance: such a call falls through to the network rules that already graded it, and those rules are unchanged.
export type EgressScreenResult =
  | { outcome: "not-public" }
  | { outcome: "public-benign" }
  | { outcome: "public-raw-ip" }
  | { outcome: "screened"; signal: EgressScreenSignal };

// Grade one `web_fetch` invocation from its arguments alone. HOST-DERIVED end to end: every input is the URL the host is about to fetch, and nothing a tool or a plugin asserts about itself participates. The credential test reuses scrubSecretsForLLM, the same pattern set the audit and LLM-egress paths redact with, so "credential-shaped" means one thing in this codebase rather than two. Signal order decides only which reason is reported, never whether the call escalates: the most definitive shapes are named first so the message a person reads is the most specific true one.
export function screenEgressRequest(input: Record<string, unknown>): EgressScreenResult {
  // An explicit private-network opt-in is the caller stating the fetch is aimed inside the perimeter. That request has its own approval identity and its own answer; this screen abstains rather than grading it.
  if (input.allowPrivateNetwork === true) return { outcome: "not-public" };

  const target = extractNetworkTarget(input);
  // A bare hostname is a destination with no request around it, and an absent tail is not a clean tail. An unparseable URL lands here too and keeps the verdict it has today.
  if (!target || target.kind !== "url" || target.host.length === 0) {
    return { outcome: "not-public" };
  }
  if (LOCALHOST_HOSTS.has(target.host)) return { outcome: "not-public" };
  const address = classifyAddressLiteral(target.host);
  if (address.literal && !address.routable) return { outcome: "not-public" };

  if (target.hasUserInfo) return { outcome: "screened", signal: "url-userinfo" };

  const tail = `${target.path}${target.query}${target.fragment}`;
  if (scrubSecretsForLLM(tail) !== tail) {
    return { outcome: "screened", signal: "credential-in-url" };
  }
  if (tail.length > EXFIL_URL_TAIL_MAX_CHARS) {
    return { outcome: "screened", signal: "oversized-url-tail" };
  }
  if (carriesOpaquePayload(target)) {
    return { outcome: "screened", signal: "high-entropy-blob" };
  }

  // A public address literal is a destination nobody named. That is not by itself a signal of data leaving, so it does not reach HIGH; it is also not the ordinary documentation fetch this lane exists for, so it does not reach LOW.
  if (address.literal) return { outcome: "public-raw-ip" };
  return { outcome: "public-benign" };
}

// Guest isolation covers filesystem/process effects, never network: LOW requires positively understood local work or plain downloads. Reject expansions anywhere, env assignments, xargs, device-network paths, unknown/abbreviated options and remote option values; local positionals exclude colons, clone/fetch sources use separate predicates, toolchain flags cannot carry programs, and wrappers recursively grade their command.
// Destructive token/raw forms, abbreviated dangerous flags, forced/deleted refs, aborted operations and inline interpreter code stay MEDIUM; recoverable rewrites/regenerable cleanup may qualify. Allowed scripts, builds, hooks, config and download URL/DNS data can still execute or exfiltrate: guest egress policy owns that residual, and host grading never uses this allowlist.

type GuestShellGrade = "local" | "destructive" | "unlisted";

// curl options of a plain GET download, exact spellings only (curl accepts abbreviations; this does not).
const CURL_GET_FLAG_OPTIONS: ReadonlySet<string> = new Set([
  "--remote-name", "--remote-name-all", "--location", "--silent", "--show-error", "--fail",
  "--fail-with-body", "--insecure", "--compressed", "--progress-bar", "--verbose",
  "--create-dirs", "--remote-header-name", "--head", "--include", "--http1.1", "--http2",
  "--ipv4", "--ipv6", "--no-progress-meter", "--retry-connrefused", "--retry-all-errors",
]);
const CURL_GET_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--output", "--output-dir", "--retry", "--retry-delay", "--retry-max-time",
  "--connect-timeout", "--max-time", "--continue-at", "--max-filesize", "--max-redirs",
]);
const CURL_GET_SHORT_FLAGS: ReadonlySet<string> = new Set(["O", "L", "s", "S", "f", "k", "v", "J", "I", "i", "#", "4", "6"]);
const CURL_GET_SHORT_VALUES: ReadonlySet<string> = new Set(["o", "m", "C"]);

// wget options of a plain GET download, exact spellings only.
const WGET_GET_FLAG_OPTIONS: ReadonlySet<string> = new Set([
  "--quiet", "--no-verbose", "--verbose", "--continue", "--timestamping", "--no-check-certificate",
  "--retry-connrefused", "--show-progress", "--no-clobber", "--no-parent", "--no-directories",
  "--no-host-directories", "--server-response", "--https-only", "--inet4-only", "--inet6-only",
  "-nv", "-nc", "-np", "-nd", "-nH",
]);
const WGET_GET_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--output-document", "--directory-prefix", "--tries", "--timeout", "--waitretry", "--progress",
  "--cut-dirs", "--max-redirect",
]);
const WGET_GET_SHORT_FLAGS: ReadonlySet<string> = new Set(["q", "c", "N", "S", "v", "4", "6"]);
const WGET_GET_SHORT_VALUES: ReadonlySet<string> = new Set(["O", "P", "t", "T"]);

// True when every option is an exact allowlisted GET form and every operand is a plain public http(s) URL the host's own fetch screen grades benign and that has no query, fragment or userinfo. That narrows the obvious carriers; it does not make the URL path, hostname or DNS lookup safe (a stated limit). A value-taking option consumes the rest of its short cluster, its `=value`, or the next word.
function isPlainGetDownload(
  args: readonly string[],
  flags: ReadonlySet<string>,
  values: ReadonlySet<string>,
  shortFlags: ReadonlySet<string>,
  shortValues: ReadonlySet<string>,
): boolean {
  let urls = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--") || flags.has(arg)) {
      const eq = arg.indexOf("=");
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      if (flags.has(name) && eq < 0) continue;
      if (!values.has(name)) return false;
      if (eq < 0) i++;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j]!;
        if (shortFlags.has(letter)) continue;
        if (!shortValues.has(letter)) return false;
        if (j + 1 >= arg.length) i++;
        break;
      }
      continue;
    }
    if (!isPlainDownloadUrl(arg)) return false;
    urls++;
  }
  return urls > 0;
}

function isPlainDownloadUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  const target = extractNetworkTarget({ url: value });
  if (target === null || target.kind !== "url" || target.hasUserInfo) return false;
  if (target.query !== "" || target.fragment !== "") return false;
  return screenEgressRequest({ url: value }).outcome === "public-benign";
}

// Nesting limit for wrappers that run another program.
const GUEST_WRAPPER_MAX_DEPTH = 3;

// The options and positionals one tool (or one subcommand) accepts for LOW. Options match by exact spelling only. A value-taking option consumes its `=value`, the rest of its short cluster, or the next word.
interface GuestArgvSpec {
  readonly flags?: readonly string[];
  readonly values?: readonly string[];
  // Short letters allowed in a cluster without a value.
  readonly short?: string;
  // Short letters that take a value.
  readonly shortValues?: string;
  // The words the FIRST positional may be (a subcommand such as `git submodule update`). Named explicitly so a positional predicate can never admit a subcommand that runs a command (`submodule foreach`).
  readonly subcommands?: readonly string[];
  // Every other positional must pass; absent = no positional allowed.
  readonly positional?: (arg: string) => boolean;
  // Options (long, or `-x` for a short letter) whose value is text — a message, format, pattern, selector or time — never a file or a host. Such a value is still refused when it carries a URL, but not for the `host:path` form, which a commit message (`-m "fix: x"`), a date or a format (`%(refname:short)`) legitimately has.
  readonly textValues?: readonly string[];
  // Extra checks for particular option values, keyed by option (`--editable`, `-e`).
  readonly valueChecks?: Readonly<Record<string, (value: string) => boolean>>;
  // Words after this many positionals are a program's own arguments.
  readonly restAfterPositionals?: number;
  // Words after a bare `--` are a program's own arguments.
  readonly restAfterDoubleDash?: boolean;
}

// The remote-file form `host:path` / `user@host:path`: a `:` before any `/`. tar (`-f host:/a.tar`), rsync and cp-like tools open a connection for it, so no option value of that shape is local. git's scp-form sources are checked separately by `isGuestGitSource`, never through option values.
const GUEST_REMOTE_OPERAND_RE = /^[^/]*:/;

// Values never carry a URL or a remote `host:path`; either one is a source or sink.
function isGuestOptionValue(value: string | undefined, text = false): boolean {
  return value !== undefined && !/:\/\//.test(value) && !value.startsWith("@") && (text || !GUEST_REMOTE_OPERAND_RE.test(value));
}

function matchesGuestArgvSpec(args: readonly string[], spec: GuestArgvSpec): boolean {
  const flags = new Set(spec.flags ?? []);
  const values = new Set(spec.values ?? []);
  const short = spec.short ?? "";
  const shortValues = spec.shortValues ?? "";
  const textValues = new Set(spec.textValues ?? []);
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      // A subcommand is never taken from after `--`.
      if (spec.subcommands !== undefined && positionals === 0) return false;
      return spec.restAfterDoubleDash === true || args.slice(i + 1).every((rest) => spec.positional?.(rest) === true);
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (flags.has(arg)) continue;
      const eq = arg.indexOf("=");
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      if (values.has(name)) {
        const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
        if (!isGuestOptionValue(value, textValues.has(name)) || spec.valueChecks?.[name]?.(value!) === false) return false;
        continue;
      }
      if (arg.startsWith("--")) return false;
      let consumed = false;
      for (let j = 1; j < arg.length && !consumed; j++) {
        const letter = arg[j]!;
        if (short.includes(letter)) continue;
        if (!shortValues.includes(letter)) return false;
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (!isGuestOptionValue(value, textValues.has(`-${letter}`)) || spec.valueChecks?.[`-${letter}`]?.(value!) === false) return false;
        consumed = true;
      }
      continue;
    }
    if (spec.restAfterPositionals !== undefined && positionals >= spec.restAfterPositionals) return true;
    const admitted = spec.subcommands !== undefined && positionals === 0
      ? spec.subcommands.includes(arg)
      : spec.positional?.(arg) === true;
    if (!admitted) return false;
    positionals++;
  }
  return true;
}

// A literal local path word: path characters only, so never a command string (no spaces or shell syntax), never a URL or `host:` remote form, never an option. A path predicate admits FILES; a spec whose first positional is a subcommand names those words in `subcommands` instead.
function isGuestLocalPath(arg: string): boolean {
  return /^[A-Za-z0-9._\/~+%,=@-]+$/.test(arg) && !arg.startsWith("-");
}

// An editable install target: a local path, optionally with extras (`.[dev]`).
function isGuestEditableTarget(arg: string): boolean {
  const extras = /^(.*?)(\[[A-Za-z0-9._,-]+\])?$/.exec(arg);
  return extras !== null && isGuestLocalPath(extras[1]!);
}

// A data word the tool matches or names but never executes (a grep pattern, a test-name filter): no URL. Never used where a word could be a command.
function isGuestLiteralWord(arg: string): boolean {
  return !/:\/\//.test(arg) && !arg.startsWith("@");
}

const PY_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?((===|==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+!_-]+(,(===|==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+!_-]+)*)?$/;
const NPM_SPEC_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9.^~<>=*+_-]+)?$/i;
const CARGO_SPEC_RE = /^[A-Za-z0-9_-]+(@[A-Za-z0-9.^~<>=*+-]+)?$/;
const GEM_SPEC_RE = /^[A-Za-z0-9_.-]+$/;
const OS_PACKAGE_RE = /^[a-z0-9][a-z0-9.+_-]*(:[a-z0-9-]+)?(=[A-Za-z0-9.+:~_-]+)?(\/[a-z0-9.-]+)?$/;
const CONDA_SPEC_RE = /^[A-Za-z0-9_.-]+((==|=|>=|<=|>|<|!=)[A-Za-z0-9.*_+-]+)*$/;
const GO_MODULE_RE = /^[a-z0-9.-]+\.[a-z]{2,}(\/[A-Za-z0-9._~-]+)+(\/\.\.\.)?(@[A-Za-z0-9._+-]+)?$/;
const GO_PACKAGE_RE = /^(\.{1,2}|\.{1,2}\/[A-Za-z0-9._~\/-]*|[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*)(\/\.\.\.)?$|^[A-Za-z0-9._\/-]+\.go$/;

const PIP_INSTALL_SPEC: GuestArgvSpec = {
  flags: ["--upgrade", "--user", "--quiet", "--verbose", "--no-cache-dir", "--no-deps", "--pre",
    "--break-system-packages", "--no-build-isolation", "--prefer-binary", "--force-reinstall",
    "--ignore-installed", "--disable-pip-version-check", "--no-input", "--no-warn-script-location",
    "--no-compile", "--require-hashes", "--dry-run", "--system"],
  values: ["--requirement", "--constraint", "--upgrade-strategy", "--root-user-action", "--only-binary",
    "--no-binary", "--target", "--progress-bar", "--timeout", "--retries", "--dest", "--python", "--editable"],
  short: "UqvI",
  shortValues: "rctdpe",
  positional: (arg) => PY_SPEC_RE.test(arg),
  // Requirement and constraint files and editable targets are local paths; `-e git+…`, `-e host:repo` or a URL are sources and stay MEDIUM.
  valueChecks: {
    "--requirement": isGuestLocalPath, "-r": isGuestLocalPath,
    "--constraint": isGuestLocalPath, "-c": isGuestLocalPath,
    "--editable": isGuestEditableTarget, "-e": isGuestEditableTarget,
  },
};
const PIP_QUERY_SPEC: GuestArgvSpec = {
  flags: ["--verbose", "--files", "--outdated", "--uptodate", "--not-required", "--user", "--local", "--yes", "--quiet"],
  values: ["--format", "--requirement"],
  short: "vfoulyq",
  shortValues: "r",
  positional: (arg) => PY_SPEC_RE.test(arg),
  valueChecks: { "--requirement": isGuestLocalPath, "-r": isGuestLocalPath },
};
const PIP_SUBCOMMANDS: ReadonlyMap<string, GuestArgvSpec> = new Map<string, GuestArgvSpec>([
  ["install", PIP_INSTALL_SPEC], ["download", PIP_INSTALL_SPEC],
  ["uninstall", PIP_QUERY_SPEC], ["list", PIP_QUERY_SPEC], ["show", PIP_QUERY_SPEC],
  ["freeze", PIP_QUERY_SPEC], ["check", PIP_QUERY_SPEC], ["sync", { ...PIP_INSTALL_SPEC, positional: isGuestLocalPath }],
]);

const NPM_INSTALL_SPEC: GuestArgvSpec = {
  flags: ["--no-audit", "--no-fund", "--save-dev", "--save", "--save-exact", "--production",
    "--legacy-peer-deps", "--no-save", "--silent", "--global", "--ignore-scripts", "--prefer-offline",
    "--no-package-lock", "--workspaces", "--all", "--json", "--no-optional", "--frozen-lockfile",
    "--no-frozen-lockfile", "--prod", "--recursive", "--offline", "--workspace-root", "--immutable",
    "--dev", "--exact", "--check-files"],
  values: ["--omit", "--include", "--loglevel", "--workspace", "--depth", "--filter"],
  short: "DSEsgaPrdE",
  shortValues: "wF",
  positional: (arg) => NPM_SPEC_RE.test(arg),
};
// Script runners: the script itself is the documented script limitation.
const NPM_SCRIPT_SPEC: GuestArgvSpec = {
  flags: ["--silent", "--if-present", "--workspaces"],
  values: ["--workspace"],
  short: "s",
  shortValues: "w",
  positional: (arg) => /^[A-Za-z0-9:_.-]+$/.test(arg),
  restAfterDoubleDash: true,
};
const PNPM_SCRIPT_SPEC: GuestArgvSpec = { ...NPM_SCRIPT_SPEC, restAfterPositionals: 1 };

const CARGO_BUILD_SPEC: GuestArgvSpec = {
  flags: ["--release", "--locked", "--frozen", "--offline", "--quiet", "--verbose", "--all-features",
    "--no-default-features", "--workspace", "--all-targets", "--lib", "--bins", "--tests", "--benches",
    "--examples", "--no-run", "--no-fail-fast", "--all", "--doc", "--check", "-vv"],
  values: ["--features", "--package", "--bin", "--example", "--test", "--bench", "--target",
    "--target-dir", "--manifest-path", "--jobs", "--profile", "--color", "--message-format", "--exclude", "--depth"],
  short: "rqv",
  shortValues: "Fpj",
  // A target is a triple-shaped name, never a `.json` target spec path: a spec file can name the linker to run. A name that is not built in resolves through rustc's target search, so a planted target file is the stated planted-file limit.
  valueChecks: { "--target": (value) => /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(value) && !value.endsWith(".json") },
  positional: isGuestLiteralWord,
  restAfterDoubleDash: true,
};

// Splits a go tool-flags value the way the go command does: an optional `pattern=` prefix when the value does not start with `-`, then space-separated words with single or double quotes. Null when malformed.
function splitGoToolFlags(value: string): string[] | null {
  let rest = value;
  if (rest !== "" && !rest.startsWith("-")) {
    const eq = rest.indexOf("=");
    if (eq < 0) return null;
    rest = rest.slice(eq + 1);
  }
  const words: string[] = [];
  const re = /\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/gy;
  let match: RegExpExecArray | null;
  while (re.lastIndex < rest.length && (match = re.exec(rest)) !== null) {
    if (match[0].trim() === "") break;
    words.push(match[1] ?? match[2] ?? match[3]!);
  }
  return rest.slice(re.lastIndex).trim() === "" ? words : null;
}

interface GoToolFlags {
  // Words allowed as they are (`-s`, `-N`).
  readonly flags: ReadonlySet<string>;
  // Flags taking the next word as a non-program value (`-X name=value`).
  readonly values: ReadonlySet<string>;
  // Allowed `-name=value` spellings, matched on the whole word.
  readonly assigned: RegExp;
}
// go tool link: strip, version stamping and internal linking only — never `-extld`, `-extldflags`, `-linkmode=external`, `-installsuffix` or an unknown flag, any of which can hand the build to another program.
const GO_LDFLAGS_ALLOWED: GoToolFlags = {
  flags: new Set(["-s", "-w", "-v", "-race", "-msan", "-asan"]),
  values: new Set(["-X"]),
  assigned: /^-(X=[A-Za-z0-9_.\/-]+=.*|buildid=[A-Za-z0-9_.\/=+-]*|linkmode=internal|compressdwarf=(true|false)|strictdups=[0-2])$/,
};
// go tool compile: optimisation, inlining and diagnostic switches.
const GO_GCFLAGS_ALLOWED: GoToolFlags = {
  flags: new Set(["-N", "-l", "-m", "-S", "-B", "-C", "-e", "-w", "-live", "-wb", "-race", "-K", "-h"]),
  values: new Set([]),
  assigned: /^-(m=[0-9]|d=[A-Za-z0-9_.,\/=]+|l=[0-9]|c=[0-9]+|spectre=[a-z,]*|trimpath=[A-Za-z0-9._\/~;=-]*)$/,
};
// go tool asm: defines and include directories only.
const GO_ASMFLAGS_ALLOWED: GoToolFlags = {
  flags: new Set(["-S", "-e", "-shared", "-dynlink"]),
  values: new Set(["-D", "-I"]),
  assigned: /^-(D=[A-Za-z0-9_]+(=[A-Za-z0-9_.-]*)?|I=[A-Za-z0-9._\/~-]+|spectre=[a-z,]*|trimpath=[A-Za-z0-9._\/~;=-]*)$/,
};

function isGoToolFlagsValue(value: string, allowed: GoToolFlags): boolean {
  const words = splitGoToolFlags(value);
  if (words === null) return false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (allowed.flags.has(word) || allowed.assigned.test(word)) continue;
    if (allowed.values.has(word)) {
      const next = words[++i];
      if (next === undefined || next.startsWith("-") || /:\/\//.test(next)) return false;
      continue;
    }
    return false;
  }
  return true;
}

// go flags are single-dash words (`-race`, `-o file`, `-tags=x`); no abbreviation.
const GO_BUILD_SPEC: GuestArgvSpec = {
  flags: ["-v", "-x", "-n", "-a", "-race", "-msan", "-trimpath", "-short", "-cover", "-json",
    "-failfast", "-benchmem", "-i", "-e", "-m", "-u", "-d", "-t"],
  values: ["-o", "-tags", "-run", "-count", "-timeout", "-mod", "-ldflags", "-gcflags", "-asmflags",
    "-p", "-bench", "-benchtime", "-coverprofile", "-coverpkg", "-covermode", "-C", "-cpu",
    "-parallel", "-buildvcs", "-skip", "-shuffle", "-f", "-go"],
  textValues: ["-tags", "-run", "-timeout", "-ldflags", "-gcflags", "-asmflags", "-bench", "-benchtime", "-skip"],
  // The tool flags are parsed into their own words: a linker, compiler or assembler flag that names a program, plugin or option file is not LOW.
  valueChecks: {
    "-ldflags": (value) => isGoToolFlagsValue(value, GO_LDFLAGS_ALLOWED),
    "-gcflags": (value) => isGoToolFlagsValue(value, GO_GCFLAGS_ALLOWED),
    "-asmflags": (value) => isGoToolFlagsValue(value, GO_ASMFLAGS_ALLOWED),
  },
  positional: (arg) => GO_PACKAGE_RE.test(arg) || GO_MODULE_RE.test(arg),
};

const OS_PACKAGE_SPEC: GuestArgvSpec = {
  flags: ["--yes", "--assume-yes", "--quiet", "--no-install-recommends", "--no-install-suggests",
    "--fix-broken", "--fix-missing", "--allow-downgrades", "--reinstall", "--only-upgrade", "--purge",
    "--no-cache", "--update", "--assumeyes", "--nodocs", "-qq"],
  values: ["--virtual"],
  short: "yqfU",
  shortValues: "t",
  positional: (arg) => OS_PACKAGE_RE.test(arg),
};

const BUILD_GOAL_RE = /^(clean|compile|test|package|verify|install|validate|build|assemble|check|run|dependencies|test-compile|dependency:resolve|dependency:go-offline)$/;
const MVN_SPEC: GuestArgvSpec = {
  flags: ["--quiet", "--batch-mode", "--offline", "--errors", "--debug", "--update-snapshots",
    "--no-transfer-progress", "-ntp", "--no-daemon", "--info", "--stacktrace", "--build-cache",
    "--parallel", "--continue"],
  values: ["--file", "-pl", "--projects", "--threads", "--console", "--exclude-task", "--project-dir"],
  textValues: ["-pl", "--projects", "--exclude-task", "-x"],
  short: "qBoeXUis",
  shortValues: "fTxp",
  positional: (arg) => BUILD_GOAL_RE.test(arg),
};

// Per-tool subcommand specs; the first positional is the subcommand.
const GUEST_SUBCOMMAND_TOOLS: ReadonlyMap<string, ReadonlyMap<string, GuestArgvSpec>> = new Map<string, ReadonlyMap<string, GuestArgvSpec>>([
  ["pip", PIP_SUBCOMMANDS],
  ["pip3", PIP_SUBCOMMANDS],
  ["npm", new Map<string, GuestArgvSpec>([
    ...["install", "i", "ci", "uninstall", "un", "remove", "rm", "update", "up", "dedupe", "prune",
      "rebuild", "ls", "list", "pack"].map((sub) => [sub, NPM_INSTALL_SPEC] as [string, GuestArgvSpec]),
    ...["test", "t", "start", "run", "run-script"].map((sub) => [sub, NPM_SCRIPT_SPEC] as [string, GuestArgvSpec]),
    ["init", { flags: ["--yes"], short: "y" }],
  ])],
  ["pnpm", new Map<string, GuestArgvSpec>([
    ...["install", "i", "add", "remove", "rm", "update", "up"].map((sub) => [sub, NPM_INSTALL_SPEC] as [string, GuestArgvSpec]),
    ...["run", "test", "start"].map((sub) => [sub, PNPM_SCRIPT_SPEC] as [string, GuestArgvSpec]),
  ])],
  ["yarn", new Map<string, GuestArgvSpec>([
    ...["install", "add", "remove"].map((sub) => [sub, NPM_INSTALL_SPEC] as [string, GuestArgvSpec]),
    ...["run", "test"].map((sub) => [sub, PNPM_SCRIPT_SPEC] as [string, GuestArgvSpec]),
  ])],
  ["bun", new Map<string, GuestArgvSpec>([
    ...["install", "i", "add", "remove", "rm", "update"].map((sub) => [sub, NPM_INSTALL_SPEC] as [string, GuestArgvSpec]),
    ...["test", "build"].map((sub) => [sub, {
      flags: ["--watch", "--minify", "--sourcemap", "--bail", "--coverage", "--production"],
      values: ["--outdir", "--outfile", "--target", "--timeout", "--test-name-pattern"],
      textValues: ["--test-name-pattern", "-t"],
      shortValues: "t",
      positional: isGuestLocalPath,
    }] as [string, GuestArgvSpec]),
  ])],
  ["cargo", new Map<string, GuestArgvSpec>([
    ...["build", "b", "check", "c", "test", "t", "bench", "clippy", "doc", "run", "r", "clean", "fetch",
      "tree", "metadata", "fmt"].map((sub) => [sub, CARGO_BUILD_SPEC] as [string, GuestArgvSpec]),
    ["install", { flags: ["--locked", "--force", "--offline", "--quiet"], values: ["--version", "--vers", "--root", "--features", "--bin"],
      short: "fq", shortValues: "F", positional: (arg) => CARGO_SPEC_RE.test(arg) }],
    ...["add", "remove"].map((sub) => [sub, { flags: ["--dev", "--build", "--optional"], values: ["--features", "--package"],
      shortValues: "Fp", positional: (arg: string) => CARGO_SPEC_RE.test(arg) }] as [string, GuestArgvSpec]),
    ...["new", "init"].map((sub) => [sub, { flags: ["--lib", "--bin"], values: ["--name", "--edition", "--vcs"],
      positional: isGuestLocalPath }] as [string, GuestArgvSpec]),
  ])],
  ["go", new Map<string, GuestArgvSpec>([
    ...["build", "vet", "list", "clean", "generate", "install", "get"].map((sub) => [sub, GO_BUILD_SPEC] as [string, GuestArgvSpec]),
    ["test", { ...GO_BUILD_SPEC, flags: [...GO_BUILD_SPEC.flags!, "-args"] }],
    ["run", { ...GO_BUILD_SPEC, restAfterPositionals: 1 }],
    ["version", { flags: ["-m", "-v"], positional: isGuestLocalPath }],
    ["env", { flags: ["-json"], positional: (arg) => /^[A-Z0-9_]+$/.test(arg) }],
  ])],
  ["apt", new Map<string, GuestArgvSpec>(["install", "update", "upgrade", "remove", "purge", "autoremove", "clean", "dist-upgrade"]
    .map((sub) => [sub, OS_PACKAGE_SPEC] as [string, GuestArgvSpec]))],
  ["apt-get", new Map<string, GuestArgvSpec>(["install", "update", "upgrade", "remove", "purge", "autoremove", "clean", "dist-upgrade"]
    .map((sub) => [sub, OS_PACKAGE_SPEC] as [string, GuestArgvSpec]))],
  ["apk", new Map<string, GuestArgvSpec>(["add", "del", "update", "upgrade"].map((sub) => [sub, OS_PACKAGE_SPEC] as [string, GuestArgvSpec]))],
  ["dnf", new Map<string, GuestArgvSpec>(["install", "update", "upgrade", "remove"].map((sub) => [sub, OS_PACKAGE_SPEC] as [string, GuestArgvSpec]))],
  ["yum", new Map<string, GuestArgvSpec>(["install", "update", "upgrade", "remove"].map((sub) => [sub, OS_PACKAGE_SPEC] as [string, GuestArgvSpec]))],
  ["gem", new Map<string, GuestArgvSpec>(["install", "uninstall", "list"].map((sub) => [sub, {
    flags: ["--no-document", "--user-install", "--conservative", "--quiet"], values: ["--version"],
    short: "Nq", shortValues: "v", positional: (arg: string) => GEM_SPEC_RE.test(arg),
  }] as [string, GuestArgvSpec]))],
  ["bundle", new Map<string, GuestArgvSpec>(["install", "update", "check", "list"].map((sub) => [sub, {
    flags: ["--quiet", "--frozen", "--deployment", "--local", "--prefer-local"], values: ["--jobs", "--retry", "--gemfile"],
    shortValues: "j", positional: (arg: string) => GEM_SPEC_RE.test(arg),
  }] as [string, GuestArgvSpec]))],
  ["conda", new Map<string, GuestArgvSpec>(["install", "create", "remove", "list"].map((sub) => [sub, {
    flags: ["--yes", "--quiet"], values: ["--name", "--prefix", "--file"],
    short: "yq", shortValues: "npf", positional: (arg: string) => CONDA_SPEC_RE.test(arg),
  }] as [string, GuestArgvSpec]))],
]);

// uv: `uv pip <pip subcommand>`, project commands, and `uv run` (a wrapper).
const UV_SUBCOMMANDS: ReadonlyMap<string, GuestArgvSpec> = new Map<string, GuestArgvSpec>([
  ["sync", { flags: ["--frozen", "--locked", "--no-dev", "--all-extras", "--dev", "--quiet", "--all-packages",
    "--no-install-project", "--inexact", "--no-editable"], values: ["--extra", "--group", "--python", "--package"],
    short: "q", shortValues: "p" }],
  ["lock", { flags: ["--locked", "--frozen", "--upgrade", "--check"], values: ["--upgrade-package", "--python"],
    short: "U", shortValues: "Pp" }],
  ...["add", "remove"].map((sub) => [sub, { flags: ["--dev", "--no-sync", "--frozen", "--locked"],
    values: ["--group", "--optional", "--python", "--extra"], shortValues: "p",
    positional: (arg: string) => PY_SPEC_RE.test(arg) }] as [string, GuestArgvSpec]),
  ["venv", { flags: ["--seed", "--quiet", "--clear", "--system-site-packages"], values: ["--python", "--prompt"],
    short: "q", shortValues: "p", positional: isGuestLocalPath }],
  ["init", { flags: ["--lib", "--app", "--package", "--no-readme", "--bare"], values: ["--name", "--python"],
    shortValues: "p", positional: isGuestLocalPath }],
  ["build", { flags: ["--wheel", "--sdist", "--quiet"], values: ["--out-dir"], short: "q", shortValues: "o",
    positional: isGuestLocalPath }],
  ["tree", { flags: ["--frozen", "--locked"], values: ["--depth"], shortValues: "d" }],
]);

// git: repository-locating globals only, then a per-subcommand spec.
const GIT_PATH_SPEC: GuestArgvSpec = { positional: isGuestLocalPath, restAfterDoubleDash: false };
// A literal clone/fetch source: http(s)/ssh/git URL, scp form or local path; never a transport helper (`ext::`).
function isGuestGitSource(arg: string): boolean {
  if (/::/.test(arg) || /^ext:/i.test(arg) || arg.startsWith("-")) return false;
  return /^(https?|ssh|git):\/\//i.test(arg) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._\/~-]+$/.test(arg) || isGuestLocalPath(arg);
}
const GIT_REF_RE = /^\+?[A-Za-z0-9._\/~^@{}-]+(:[A-Za-z0-9._\/~^@{}-]*)?$/;
const GIT_SUBCOMMANDS: ReadonlyMap<string, GuestArgvSpec> = new Map<string, GuestArgvSpec>([
  ["clone", { flags: ["--single-branch", "--no-single-branch", "--recurse-submodules", "--recursive",
    "--shallow-submodules", "--quiet", "--no-checkout", "--sparse", "--no-tags", "--bare", "--progress"],
    values: ["--depth", "--branch", "--filter", "--origin", "--shallow-since"], short: "qn", shortValues: "bo",
    positional: isGuestGitSource }],
  ["fetch", { flags: ["--all", "--prune", "--tags", "--unshallow", "--quiet", "--no-tags", "--force", "--progress",
    "--prune-tags"], values: ["--depth", "--shallow-since"], short: "ptqf",
    positional: (arg) => isGuestGitSource(arg) || GIT_REF_RE.test(arg) }],
  ["pull", { flags: ["--ff-only", "--rebase", "--no-rebase", "--quiet", "--all", "--tags", "--no-edit", "--ff",
    "--no-ff", "--autostash", "--progress"], values: ["--depth"], short: "rq",
    positional: (arg) => isGuestGitSource(arg) || GIT_REF_RE.test(arg) }],
  ["status", { flags: ["--short", "--branch", "--porcelain", "--ignored", "--long", "-uno", "-uall", "--untracked-files=no",
    "--untracked-files=all", "--untracked-files=normal"], short: "sbz", positional: isGuestLocalPath }],
  ["checkout", { flags: ["--quiet", "--detach", "--track", "--no-track"], values: ["-b", "-B"], short: "qt",
    positional: (arg) => GIT_REF_RE.test(arg) }],
  ["switch", { flags: ["--quiet", "--detach", "--track", "--no-track"], values: ["--create", "-c", "-C"], short: "qt",
    positional: (arg) => GIT_REF_RE.test(arg) }],
  ["branch", { flags: ["--all", "--remotes", "--list", "--verbose", "-vv", "--show-current", "--merged",
    "--no-merged"], values: ["--set-upstream-to", "--sort", "--format"], short: "arlvdm", shortValues: "u",
    textValues: ["--sort", "--format"],
    positional: (arg) => GIT_REF_RE.test(arg) }],
  ["add", { flags: ["--all", "--update", "--intent-to-add", "--force", "--verbose", "--dry-run"], short: "AuNfvn",
    positional: isGuestLocalPath, restAfterDoubleDash: true }],
  ["commit", { flags: ["--all", "--quiet", "--allow-empty", "--amend", "--no-edit", "--no-verify", "--signoff"],
    values: ["--message", "--file", "--author", "--date"], short: "aqsn", shortValues: "mF",
    textValues: ["--message", "-m", "--author", "--date"] }],
  ["restore", { flags: ["--staged", "--quiet"], values: ["--source"], short: "Sq", shortValues: "s",
    positional: isGuestLocalPath, restAfterDoubleDash: true }],
  ["reset", { flags: ["--soft", "--mixed", "--quiet", "--keep", "--merge"], short: "q",
    positional: (arg) => GIT_REF_RE.test(arg) || isGuestLocalPath(arg), restAfterDoubleDash: true }],
  ["stash", { flags: ["--include-untracked", "--keep-index", "--quiet", "--index"], values: ["--message"],
    short: "ukq", shortValues: "m", textValues: ["--message", "-m"], subcommands: ["push", "list", "show", "pop", "apply"],
    positional: (arg) => /^(stash@\{\d+\}|\d+)$/.test(arg) }],
  ["merge", { flags: ["--no-ff", "--ff-only", "--ff", "--no-edit", "--abort", "--continue", "--squash", "--quiet",
    "--no-commit"], values: ["--message"], short: "q", shortValues: "m", textValues: ["--message", "-m"],
    positional: (arg) => GIT_REF_RE.test(arg) }],
  ["rebase", { flags: ["--continue", "--abort", "--skip", "--autostash", "--quiet", "--no-autostash"],
    values: ["--onto"], short: "q", positional: (arg) => GIT_REF_RE.test(arg) }],
  ...["cherry-pick", "revert"].map((sub) => [sub, { flags: ["--no-edit", "--no-commit", "--continue", "--abort",
    "--skip"], short: "nx", positional: (arg: string) => GIT_REF_RE.test(arg) }] as [string, GuestArgvSpec]),
  ["tag", { flags: ["--list", "--annotate", "--force", "--delete"], values: ["--message"], short: "lafd", shortValues: "m",
    textValues: ["--message", "-m"],
    positional: (arg) => GIT_REF_RE.test(arg) }],
  ["init", { flags: ["--quiet", "--bare"], values: ["--initial-branch"], short: "q", shortValues: "b",
    positional: isGuestLocalPath }],
  ["mv", { flags: ["--force", "--dry-run", "--verbose"], short: "fnvk", positional: isGuestLocalPath }],
  ["rm", { flags: ["--cached", "--quiet", "--dry-run"], short: "rqn", positional: isGuestLocalPath, restAfterDoubleDash: true }],
  ["apply", { flags: ["--check", "--stat", "--3way", "--index", "--cached", "--reverse", "--verbose"], values: ["-p"],
    short: "R3v", positional: isGuestLocalPath }],
  ["grep", { flags: ["--line-number", "--ignore-case", "--files-with-matches", "--count", "--cached", "--untracked",
    "--no-index", "--word-regexp", "--extended-regexp", "--fixed-strings", "--invert-match", "--recurse-submodules"],
    values: ["-e", "--max-depth"], short: "nilwEFcvhHIrPz", shortValues: "eABC", textValues: ["-e"], positional: isGuestLiteralWord,
    restAfterDoubleDash: true }],
  ["submodule", { flags: ["--init", "--recursive", "--quiet", "--remote"], short: "q",
    subcommands: ["update", "init", "status", "sync"], positional: isGuestLocalPath }],
  ["remote", { flags: ["--verbose"], short: "v", subcommands: ["add", "show", "get-url", "set-url", "rename", "remove", "prune"],
    positional: (arg) => isGuestGitSource(arg) || GIT_REF_RE.test(arg) }],
  ["clean", GIT_PATH_SPEC],
  ["version", {}],
]);

// Splits `git [globals] <sub> <args>`; null when a global could change what git runs (`-c`, `--exec-path`, …).
function splitGitInvocation(args: readonly string[]): { sub: string; rest: readonly string[]; index: number } | null {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const arg = args[i]!;
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") { i += 2; continue; }
    if (/^--(git-dir|work-tree)=/.test(arg) || ["--no-pager", "-P", "--bare", "--no-replace-objects"].includes(arg)) { i++; continue; }
    return null;
  }
  const sub = args[i];
  return sub === undefined ? null : { sub, rest: args.slice(i + 1), index: i };
}

// Wrappers that run another program: returns the wrapped argv, or null.
function unwrapGuestRunner(argv: readonly string[]): readonly string[] | null {
  const verb = stripCommandPath(argv[0] ?? "");
  const args = argv.slice(1);
  const after = (sub: readonly string[], flags: readonly string[]): readonly string[] | null => {
    let i = sub.length;
    if (!sub.every((word, k) => args[k] === word)) return null;
    while (i < args.length && args[i]!.startsWith("-")) {
      if (args[i] === "--") { i++; break; }
      if (!flags.includes(args[i]!)) return [];
      i++;
    }
    return args.slice(i);
  };
  if (verb === "npx" || verb === "bunx") return after([], ["--yes", "-y", "--no-install"]);
  if (verb === "uv" && args[0] === "run") return after(["run"], ["--frozen", "--locked", "--no-sync", "--isolated", "-q", "--quiet"]);
  if (verb === "uvx") return after([], ["-q", "--quiet"]);
  if (verb === "bundle" && args[0] === "exec") return after(["exec"], []);
  if (verb === "bun" && (args[0] === "run" || args[0] === "x")) return after([args[0]], ["--bun", "--silent"]);
  if ((verb === "pnpm" && (args[0] === "exec" || args[0] === "dlx")) ||
      (verb === "yarn" && (args[0] === "dlx" || args[0] === "exec")) ||
      (verb === "npm" && args[0] === "exec") ||
      (verb === "poetry" && args[0] === "run") ||
      (verb === "pipx" && args[0] === "run")) {
    return after([args[0]], ["--yes", "-y", "--silent"]);
  }
  return null;
}

// Python's own options: the module named by `-m` (stuck or clustered, as in `-mtwine` or `-um pip`), whether `-c` gives inline code, and the first positional (the script, or `-` for stdin).
function parsePythonInvocation(args: readonly string[]): { module?: string; moduleArgs: readonly string[]; inline: boolean; script?: string } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-" || !arg.startsWith("-")) return { moduleArgs: [], inline: false, script: arg };
    if (arg === "--") return { moduleArgs: [], inline: false, ...(args[i + 1] === undefined ? {} : { script: args[i + 1] }) };
    if (arg.startsWith("--")) continue;
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j]!;
      if (letter === "c") return { moduleArgs: [], inline: true };
      if (letter === "m") {
        const stuck = arg.slice(j + 1);
        const module = stuck.length > 0 ? stuck : args[i + 1];
        const rest = args.slice(stuck.length > 0 ? i + 1 : i + 2);
        return { ...(module === undefined ? {} : { module }), moduleArgs: rest, inline: false };
      }
      if ("WX".includes(letter)) {
        if (j + 1 >= arg.length) i++;
        break;
      }
    }
  }
  return { moduleArgs: [], inline: false };
}

const INTERPRETER_VERSION_ARGS: ReadonlySet<string> = new Set(["-V", "--version", "-v", "-h", "--help"]);

// Interpreter code that is on the line rather than in a file: an inline-code flag, a `data:`/URL module, or a program read from stdin (`-`, a here-doc, a pipe). Its effects cannot be graded from the line.
function hasInlineInterpreterCode(verb: string, args: readonly string[]): boolean {
  const versionOnly = args.length > 0 && args.every((arg) => INTERPRETER_VERSION_ARGS.has(arg));
  if (/^python[0-9.]*$/.test(verb)) {
    const python = parsePythonInvocation(args);
    if (python.inline) return true;
    if (python.module !== undefined) return false;
    return !versionOnly && (python.script === undefined || python.script === "-");
  }
  if (verb === "node" || verb === "nodejs") {
    if (args.some((arg) => shortClusterHas(arg, "ep") || longOptionAbbreviates(arg, ["--eval", "--print"]))) return true;
    if (args.some((arg) => /data:|:\/\//.test(arg))) return true;
    const script = args.find((arg) => !arg.startsWith("-"));
    return !versionOnly && (script === undefined || args.includes("-"));
  }
  if (verb === "perl" || verb === "ruby" || verb === "php") {
    const letters = verb === "perl" ? "eE" : verb === "ruby" ? "e" : "rBRFE";
    if (args.some((arg) => shortClusterHas(arg, letters))) return true;
    const script = args.find((arg) => !arg.startsWith("-"));
    return !versionOnly && (script === undefined || args.includes("-"));
  }
  return false;
}

// System program directories; a path-qualified verb elsewhere is a file the guest may have written.
const SYSTEM_BIN_RE = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$/;

// The verb an argv[0] names for the allowlist, or null. A URL or `host:` form is never a verb. A path outside the system bin directories is a file the guest may have written, so only interpreters and project wrapper scripts — which run files anyway (the script limitation) — keep their name.
function guestVerbOf(word: string): string | null {
  if (word === ":") return word;
  if (word.includes(":")) return null;
  if (!word.includes("/")) return word;
  const base = stripCommandPath(word);
  if (SYSTEM_BIN_RE.test(word)) return base;
  return /^(python[0-9.]*|pip3?|node|pytest|gradlew|mvnw)$/.test(base) ? base : null;
}

// True when a git short cluster sets one of `letters` before a letter that takes a glued value (`-vd` → d; `-uorigin/dev` → u's value, not d).
function gitClusterHas(arg: string, letters: string, valueLetters = ""): boolean {
  if (!/^-[^-]/.test(arg)) return false;
  for (const letter of arg.slice(1)) {
    if (letters.includes(letter)) return true;
    if (valueLetters.includes(letter)) return false;
  }
  return false;
}

// Operands of `git checkout`, not counting the branch name a `-b`/`-B` takes.
function gitCheckoutOperands(rest: readonly string[]): number {
  let operands = 0;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") return operands + rest.length - i - 1;
    if (arg.startsWith("-") && arg.length > 1) {
      // `-b name`, `-B name`, `-qb name`: the branch name is the option's value.
      if (/^-[A-Za-z]*[bB]$/.test(arg)) i++;
      continue;
    }
    operands++;
  }
  return operands;
}

// The first argument that is not an option (`git reflog --verbose expire` → `expire`).
function firstOperand(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function isGuestDestructiveArgv(argv: readonly string[], depth: number): boolean {
  const verb = stripCommandPath(argv[0] ?? "");
  const args = argv.slice(1);
  if (["rm", "unlink", "shred", "dd", "sudo", "doas", "su", "truncate"].includes(verb) || verb.startsWith("mkfs")) return true;
  if (verb === "find") return args.some((arg) => arg === "-delete");
  if (verb === "rsync") {
    return args.some((arg) => longOptionAbbreviates(arg, ["--del", "--delete", "--delete-before", "--delete-during",
      "--delete-delay", "--delete-after", "--delete-excluded", "--delete-missing-args", "--remove-source-files"]));
  }
  if (verb === "tar") return args.some((arg) => longOptionAbbreviates(arg, ["--remove-files"]));
  if (hasInlineInterpreterCode(verb, args)) return true;
  if (verb === "git") {
    const git = splitGitInvocation(args);
    if (git === null) return false;
    const { sub, rest } = git;
    if (sub === "clean") return true;
    if (sub === "reset") return rest.some((arg) => longOptionAbbreviates(arg, ["--hard"]));
    // `checkout -B` / `switch -C` reset an existing branch to a new start point. `git checkout <tree-ish> <path>…` overwrites the paths from the tree-ish, so two or more operands are destructive. A single operand (`git checkout f.txt`) cannot be told from a branch switch on the line and stays LOW: a stated limit.
    if (sub === "checkout") {
      return rest.some((arg) => arg === "--" || arg === "." || gitClusterHas(arg, "fB", "b") || longOptionAbbreviates(arg, ["--force"])) ||
        gitCheckoutOperands(rest) >= 2;
    }
    if (sub === "switch") {
      return rest.some((arg) => gitClusterHas(arg, "fC", "c") ||
        longOptionAbbreviates(arg, ["--force", "--discard-changes", "--force-create"]));
    }
    if (sub === "restore") {
      const staged = rest.some((arg) => shortClusterHas(arg, "S") || longOptionAbbreviates(arg, ["--staged"]));
      const worktree = rest.some((arg) => shortClusterHas(arg, "W") || longOptionAbbreviates(arg, ["--worktree"]));
      return !staged || worktree;
    }
    if (sub === "stash") return rest.some((arg) => arg === "drop" || arg === "clear");
    // Ref deletion, or a forced overwrite of an existing ref, discards what the ref pointed at. Short letters match anywhere in a cluster (`-vd`) and long options by prefix (`--del`), the way git's parse-options resolves them.
    if (sub === "branch") {
      return rest.some((arg) => gitClusterHas(arg, "dDfMC", "u") || longOptionAbbreviates(arg, ["--delete", "--force"]));
    }
    if (sub === "tag") return rest.some((arg) => gitClusterHas(arg, "df", "mFun") || longOptionAbbreviates(arg, ["--delete", "--force"]));
    if (sub === "fetch" || sub === "pull") {
      // `+src:dst` force-updates a local ref; a bare `+src` only updates remote-tracking refs, which the default refspec already forces.
      return rest.some((arg) => gitClusterHas(arg, "pPf", "jo") || longOptionAbbreviates(arg, ["--prune", "--prune-tags", "--force"]) ||
        (arg.startsWith("+") && arg.includes(":")));
    }
    if (sub === "remote") return ["remove", "rm", "prune"].includes(firstOperand(rest) ?? "");
    if (sub === "mv") return rest.some((arg) => gitClusterHas(arg, "f") || longOptionAbbreviates(arg, ["--force"]));
    // Abandoning an in-progress merge, rebase or pick discards its resolution work.
    if (["merge", "rebase", "cherry-pick", "revert", "am"].includes(sub)) {
      return rest.some((arg) => longOptionAbbreviates(arg, ["--abort", "--skip", "--quit"]));
    }
    if (sub === "rm") return !rest.some((arg) => arg === "--cached");
    // Subcommands whose deleting forms are not on the guest allowlist, named here so they grade as destructive rather than merely unlisted.
    if (sub === "gc" || sub === "prune" || sub === "filter-branch" || sub === "replace") return true;
    if (sub === "reflog") return ["expire", "delete"].includes(firstOperand(rest) ?? "");
    if (sub === "worktree" || sub === "notes") return ["remove", "prune"].includes(firstOperand(rest) ?? "");
    if (sub === "update-ref" || sub === "symbolic-ref") {
      return rest.some((arg) => gitClusterHas(arg, "d", "m") || longOptionAbbreviates(arg, ["--delete"]));
    }
    if (sub === "push") {
      return rest.some((arg) => gitClusterHas(arg, "df", "o") || arg.startsWith(":") || arg.startsWith("+") ||
        longOptionAbbreviates(arg, ["--delete", "--force", "--force-with-lease", "--force-if-includes", "--prune", "--mirror"]));
    }
    return false;
  }
  const wrapped = depth < GUEST_WRAPPER_MAX_DEPTH ? unwrapGuestRunner(argv) : null;
  return wrapped !== null && wrapped.length > 0 && isGuestDestructiveArgv(wrapped, depth + 1);
}

function isNetworkDevicePath(value: string): boolean {
  return /^\/dev\/(tcp|udp)\//.test(value);
}

// Options of a compiler that name a program, plugin or option file to run.
const COMPILER_ARG_RE = /^-(O[0-3sgz]?|g[0-3]?|c|S|E|o|I.*|L.*|l.*|D.*|U.*|W[a-z][^,]*|std=.*|f(?!plugin)(?!use-ld=.*\/)[a-z][a-z0-9+-]*(=[^,]*)?|m[a-z0-9-]+(=[^,]*)?|pthread|shared|static|pie|no-pie|v|x|include|isystem.*|M[MDFTPG]?|pedantic.*|w|rdynamic|march=.*)$/;

const GUEST_LITERAL_VERBS: ReadonlySet<string> = new Set([
  "mkdir", "rmdir", "touch", "cp", "mv", "ln", "chmod", "chown", "chgrp", "install", "tee", "split",
  "patch", "mktemp", "md5sum", "sha1sum", "sha256sum", "sha512sum", "xxd", "od", "hexdump", "strings",
  "unzip", "gzip", "gunzip", "zcat", "bzip2", "bunzip2", "xz", "unxz", "zstd", "unzstd", "base64", "jq",
  "nproc", "free", "lscpu", ":", "set", "unset", "exit", "wait", "shift", "umask", "pushd", "popd", "read", "[",
  "make", "ninja", "pytest", "py.test", "tsc", "awk", "gawk",
]);

function isGuestLocalArgv(leaf: ShellLeaf, argv: readonly string[], depth: number): boolean {
  if (argv.length === 0) return leaf.strippedWrappers.length === 0;
  if (argv.some(isNetworkDevicePath)) return false;
  const verb = guestVerbOf(argv[0]!);
  if (verb === null) return false;
  const args = argv.slice(1);
  const wrapped = unwrapGuestRunner(argv);
  if (wrapped !== null) {
    return depth < GUEST_WRAPPER_MAX_DEPTH && wrapped.length > 0 && isGuestLocalArgv(leaf, wrapped, depth + 1);
  }
  if (namesProgramToRun(verb, args)) return false;
  // The host's read-only classification (verb table, mutating flags, sed program scan, git inspection flags) — a read-only leaf is local.
  if (isReadOnlyShellLeaf({ ...leaf, argv: [...argv], argvHasExpandableDollar: argv.map(() => false) }, { ignoreRedirects: true })) {
    return true;
  }
  if (GUEST_LITERAL_VERBS.has(verb)) return true;
  if (verb === "sed") {
    // `-i` edits a guest file; the program itself must still pass the host scan that rejects its write/execute commands.
    const kept = argv.filter((arg) => !/^(-i\S*|--in-place(=.*)?)$/.test(arg));
    return isReadOnlyShellLeaf({ ...leaf, argv: kept, argvHasExpandableDollar: kept.map(() => false) }, { ignoreRedirects: true });
  }
  if (/^python[0-9.]*$/.test(verb)) {
    const python = parsePythonInvocation(args);
    if (python.module === "pip") return isGuestSubcommandArgv(PIP_SUBCOMMANDS, python.moduleArgs);
    // Publishing modules send local content by design.
    return python.module !== "twine";
  }
  if (verb === "node" || verb === "ruby" || verb === "perl" || verb === "php") return true;
  if (verb === "java" || verb === "javac") {
    return !args.some((arg) => arg.startsWith("@") || arg.startsWith("-XX:On") || arg.startsWith("-J"));
  }
  if (["gcc", "g++", "cc", "c++", "clang", "clang++"].includes(verb)) {
    return args.every((arg) => arg.startsWith("-") ? COMPILER_ARG_RE.test(arg) : isGuestLocalPath(arg) && !arg.startsWith("@"));
  }
  if (verb === "rustc") {
    return matchesGuestArgvSpec(args, { flags: ["--test", "-O", "-g"], values: ["--edition", "-o", "--crate-type", "--crate-name",
      "--out-dir", "-L"], positional: isGuestLocalPath });
  }
  if (verb === "cmake") {
    return args.every((arg, k) => {
      if (arg.startsWith("-D")) {
        const name = arg.slice(2).split(/[=:]/, 1)[0]!;
        return !name.startsWith("CMAKE_") || /^CMAKE_(BUILD_TYPE|INSTALL_PREFIX|EXPORT_COMPILE_COMMANDS)$/.test(name);
      }
      const previous = args[k - 1];
      if (previous !== undefined && ["-S", "-B", "-G", "--build", "-j", "--parallel", "--config", "--target", "-t", "--install", "--prefix"].includes(previous)) {
        return isGuestOptionValue(arg);
      }
      if (arg.startsWith("-")) {
        return ["-S", "-B", "-G", "--build", "-j", "--parallel", "--config", "--target", "-t", "--install", "--prefix",
          "--fresh", "-Wno-dev", "--verbose"].includes(arg) || /^-[SBG]\S/.test(arg);
      }
      return isGuestLocalPath(arg);
    });
  }
  if (verb === "mvn" || verb === "mvnw" || verb === "gradle" || verb === "gradlew") return matchesGuestArgvSpec(args, MVN_SPEC);
  if (verb === "curl") return isPlainGetDownload(args, CURL_GET_FLAG_OPTIONS, CURL_GET_VALUE_OPTIONS, CURL_GET_SHORT_FLAGS, CURL_GET_SHORT_VALUES);
  if (verb === "wget") return isPlainGetDownload(args, WGET_GET_FLAG_OPTIONS, WGET_GET_VALUE_OPTIONS, WGET_GET_SHORT_FLAGS, WGET_GET_SHORT_VALUES);
  if (verb === "tar") {
    // A dashless first argument is an old-style cluster (`xzf`, `xIf`). `--force-local` is admitted, but a `host:path` value stays unlisted even with it: the value check never depends on another option's presence.
    const words = args.length > 0 && !args[0]!.startsWith("-") ? [`-${args[0]}`, ...args.slice(1)] : args;
    return matchesGuestArgvSpec(words, {
      flags: ["--extract", "--create", "--list", "--gzip", "--gunzip", "--bzip2", "--xz", "--zstd", "--verbose",
        "--exclude-vcs", "--no-same-owner", "--no-same-permissions", "--preserve-permissions", "--overwrite",
        "--keep-old-files", "--skip-old-files", "--wildcards", "--numeric-owner", "--totals", "--auto-compress",
        "--to-stdout", "--one-top-level", "--null", "--force-local"],
      values: ["--file", "--directory", "--strip-components", "--exclude", "--owner", "--group", "--mode", "--mtime",
        "--sort", "--files-from", "--exclude-from"],
      // Patterns, owners, modes and times are text; `-f`, `-C`, `-T`, `-X` and their long forms name files and keep the `host:path` check.
      textValues: ["--exclude", "--owner", "--group", "--mode", "--mtime", "--sort"],
      short: "cxtuarzjJavpkhSmOWP",
      shortValues: "fCTX",
      positional: isGuestLocalPath,
    });
  }
  if (verb === "zip") {
    return matchesGuestArgvSpec(args, { flags: ["--recurse-paths", "--quiet", "--junk-paths"], short: "rqjyXD0123456789x",
      positional: isGuestLocalPath });
  }
  if (verb === "rsync") {
    return matchesGuestArgvSpec(args, {
      flags: ["--archive", "--verbose", "--compress", "--recursive", "--progress", "--partial", "--human-readable",
        "--dry-run", "--checksum", "--update", "--quiet", "--stats", "--times", "--perms", "--links", "--hard-links",
        "--relative", "--itemize-changes", "--whole-file", "--sparse", "--one-file-system", "--prune-empty-dirs",
        "--no-perms", "--no-owner", "--no-group", "--mkpath", "--inplace", "--append", "--ignore-existing",
        "--existing", "--size-only", "--copy-links"],
      values: ["--exclude", "--include", "--exclude-from", "--info", "--chmod"],
      textValues: ["--exclude", "--include", "--info", "--chmod"],
      short: "avzrPhnpogtlDHAXucqiWSxRmL",
      positional: isGuestLocalPath,
    });
  }
  if (verb === "git") {
    const git = splitGitInvocation(args);
    if (git === null) return false;
    const spec = GIT_SUBCOMMANDS.get(git.sub);
    if (spec === undefined) {
      // Inspection subcommands keep the host's read-only flag allowlist.
      return isReadOnlyShellLeaf({ ...leaf, argv: ["git", git.sub, ...git.rest], argvHasExpandableDollar: [] }, { ignoreRedirects: true });
    }
    return matchesGuestArgvSpec(git.rest, spec);
  }
  if (verb === "uv") {
    if (args[0] === "pip") return isGuestSubcommandArgv(PIP_SUBCOMMANDS, args.slice(1));
    if (args[0] === "python") {
      return matchesGuestArgvSpec(args.slice(1), { subcommands: ["install", "list", "find", "pin"],
        positional: (arg) => /^([A-Za-z]+-?)?[0-9][0-9.]*$/.test(arg) });
    }
    return isGuestSubcommandArgv(UV_SUBCOMMANDS, args);
  }
  if (verb === "yarn") {
    // `yarn <script>`: a bare word that is not a yarn command runs a package script (the documented script limitation); every other yarn command is unlisted unless its spec says otherwise.
    const sub = args.find((arg) => !arg.startsWith("-"));
    if (sub !== undefined && !YARN_COMMANDS.has(sub) && /^[A-Za-z0-9:_.-]+$/.test(sub)) {
      return args.indexOf(sub) === 0;
    }
  }
  if (verb === "go" && args[0] === "mod") {
    return matchesGuestArgvSpec(args.slice(1), { flags: ["-x", "-v", "-json", "-e"],
      subcommands: ["download", "tidy", "verify", "graph", "why", "vendor", "init"],
      positional: (arg) => GO_MODULE_RE.test(arg) || GO_PACKAGE_RE.test(arg) });
  }
  const subcommands = GUEST_SUBCOMMAND_TOOLS.get(verb);
  return subcommands !== undefined && isGuestSubcommandArgv(subcommands, args);
}

// Built-in yarn commands (v1 and berry); a bare word outside this set is a package script.
const YARN_COMMANDS: ReadonlySet<string> = new Set([
  "add", "audit", "autoclean", "bin", "cache", "check", "config", "create", "dedupe", "dlx", "exec", "explain",
  "generate-lock-entry", "global", "help", "import", "info", "init", "install", "licenses", "link", "list",
  "login", "logout", "node", "npm", "outdated", "owner", "pack", "patch", "plugin", "policies", "publish",
  "rebuild", "remove", "run", "search", "set", "stage", "tag", "team", "test", "unlink", "unplug", "up",
  "upgrade", "upgrade-interactive", "version", "versions", "why", "workspace", "workspaces",
]);

// The first word must be a listed subcommand; every word after it must fit that subcommand's spec.
function isGuestSubcommandArgv(subcommands: ReadonlyMap<string, GuestArgvSpec>, args: readonly string[]): boolean {
  const sub = args[0];
  if (sub === undefined) return false;
  const spec = subcommands.get(sub);
  return spec !== undefined && matchesGuestArgvSpec(args.slice(1), spec);
}

// Whether a leaf is eligible for guest LOW at all: everything it does must be visible on the line. Expansions, environment assignments, `xargs` and network device paths are not.
function isGuestEligibleLeaf(leaf: ShellLeaf): boolean {
  if (leaf.hasExpansion || leaf.hasCommandSubstitution || leaf.hasProcessSubstitution) return false;
  if (leaf.assignments.length > 0) return false;
  if (leaf.strippedWrappers.includes("xargs")) return false;
  return !leaf.redirectTargets.some(isNetworkDevicePath) && !leaf.inputRedirectTargets.some(isNetworkDevicePath);
}

// Grade one guest shell command line. `destructive` takes precedence; a line is `local` only when it tokenizes cleanly and every leaf is eligible and allowlisted.
function gradeDisposableGuestShellCommand(command: string): GuestShellGrade {
  if (DESTRUCTIVE_SHELL_RE.test(command)) return "destructive";
  const { leaves, parseError } = tokenizeShell(command);
  if (!parseError && leaves.some((leaf) => isGuestDestructiveArgv(leaf.argv, 0))) return "destructive";
  if (parseError || leaves.length === 0) return "unlisted";
  return leaves.every((leaf) => isGuestEligibleLeaf(leaf) && isGuestLocalArgv(leaf, leaf.argv, 0)) ? "local" : "unlisted";
}

function extractNetworkMethod(input: Record<string, unknown>): string | null {
  for (const key of ["method", "httpMethod", "verb"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().toUpperCase();
    }
  }
  return null;
}

function hasMeaningfulPayload(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

function hasNetworkPayload(input: Record<string, unknown>): boolean {
  for (const key of [
    "payload",
    "body",
    "data",
    "content",
    "message",
    "text",
    "summary",
    "file",
    "files",
    "attachment",
    "attachments",
  ]) {
    if (hasMeaningfulPayload(input[key])) return true;
  }
  return false;
}

const NETWORK_DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set([
  ...NETWORK_TARGET_FIELDS,
  "method",
  "httpMethod",
  "verb",
]);

function hasNonDescriptorGraphInput(input: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(input)) {
    if (NETWORK_DESCRIPTOR_FIELDS.has(key)) continue;
    if (hasMeaningfulPayload(value)) return true;
  }
  return false;
}

function isGraphMetadataRead(input: Record<string, unknown>, target: NetworkTarget): boolean {
  const method = extractNetworkMethod(input) ?? "GET";
  if (method !== "GET" || hasNetworkPayload(input) || hasNonDescriptorGraphInput(input)) return false;
  const normalizedPath = target.path.replace(/\/+$/, "");
  return normalizedPath === "/v1.0/me" || normalizedPath === "/beta/me" || normalizedPath === "/me";
}

// Resolve ~ and relative operands against invocation cwd with the same resolver as enforcement, then canonicalize/case-fold before comparing. Both sides need identical normalization so traversal, symlink, Unicode or case spelling cannot bypass sandbox containment.
function extractDeclaredPaths(ctx: ToolInvocationContext): string[] {
  const paths: string[] = [];
  for (const field of ctx.pathFields) {
    const values = selectDeclaredPathValues(ctx.finalInput, field);
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) continue;
      try {
        paths.push(
          caseFoldForMatch(
            canonicalizePathForMatch(
              resolveToolPathForPermission(value, ctx.executionCwd),
            ),
          ),
        );
      } catch {
        // Mirror the enforcer: tool schema validation owns argument-type failures. An unresolvable path contributes nothing, and an empty path list falls through to the "write path not declared" HIGH rule — the safe direction.
      }
    }
  }
  return [...new Set(paths)];
}

// Share the enforced prefix predicate but retain geometric outside-scope risk for reads even when enforcement exempts them. Both targets and allowed roots must already be canonical; this check performs no filesystem lookup.
function isInsideAllowed(path: string, allowed: readonly string[]): boolean {
  return isPathAllowed(path, { directories: allowed });
}

const RULES: Array<(ctx: ToolInvocationContext) => RiskVerdict | null> = [
  // credential-exfiltration floor First, ahead of the disposable-guest lane: a guest's egress is not confined, and a file-sourced upload is the exfiltration shape whatever substrate runs it. HIGH keeps it once-only at the approval gate.
  (ctx) => {
    if (ctx.category !== "shell") return null;
    const cwd = shellInvocationCwd(ctx);
    // The builtin PowerShell tool's text is read as PowerShell (the reading the permission floor uses); every other shell-category tool as bash.
    const signalOf = ctx.source === "builtin" && ctx.toolName === "powershell"
      ? powerShellExfiltrationSignal
      : shellExfiltrationSignal;
    for (const cmd of extractShellCommands(ctx.finalInput)) {
      const signal = signalOf(cmd, cwd);
      if (signal) return { level: "high", reason: `${SHELL_EXFIL_VERDICT_REASON} (${signal})` };
    }
    return null;
  },
  // Only broker-routed disposable guests qualify, never same-process attested containers; the broker rejects host paths. Grade destructive first, unknown/network-capable shell forms next as MEDIUM, and allowlisted local/download work LOW before host rules. Network tools still use ordinary network rules.
  (ctx) => {
    if (!isDisposableSubstrateCapability(ctx.sandboxCapability)) return null;
    if (ctx.category !== "shell") return null;
    const grades = extractShellCommands(ctx.finalInput).map(gradeDisposableGuestShellCommand);
    if (!grades.includes("destructive")) return null;
    return { level: "medium", reason: "shell destructive verb inside disposable guest" };
  },
  (ctx) => {
    if (!isDisposableSubstrateCapability(ctx.sandboxCapability)) return null;
    if (ctx.category !== "shell") return null;
    const grades = extractShellCommands(ctx.finalInput).map(gradeDisposableGuestShellCommand);
    if (grades.length > 0 && grades.every((grade) => grade === "local")) return null;
    return {
      level: "medium",
      reason: "shell outside the disposable-guest allowlist (may send data out; egress is not confined)",
    };
  },
  (ctx) => {
    if (!isDisposableSubstrateCapability(ctx.sandboxCapability)) return null;
    if (ctx.category === "shell") {
      return { level: "low", reason: "shell confined to disposable guest" };
    }
    if (ctx.category === "write") {
      return { level: "low", reason: "write confined to disposable guest" };
    }
    if (ctx.category === "read") {
      return { level: "low", reason: "read confined to disposable guest" };
    }
    return null;
  },
  // shell rules (3)
  (ctx) => {
    if (ctx.category !== "shell") return null;
    // Every command-bearing field, not just the first populated one — a destructive `script` next to a benign `command` must still read high.
    const cmds = extractShellCommands(ctx.finalInput);
    if (cmds.some((cmd) => DESTRUCTIVE_SHELL_RE.test(cmd))) {
      return { level: "high", reason: "shell destructive verb" };
    }
    return null;
  },
  // The existing rule-verdict reason carries floor context without changing risk levels.
  (ctx) => {
    if (ctx.category !== "shell" || ctx.source !== "builtin"
      || (ctx.toolName !== "bash" && ctx.toolName !== "powershell")) return null;
    const commands = extractShellCommands(ctx.finalInput);
    const destructive = ctx.toolName === "bash" && commands.some((command) =>
      tokenizeShell(command).leaves.some((leaf) => isDestructiveShellArgv(leaf.argv) || noReusableRuleReason(leaf.argv) !== null));
    const inspect = ctx.toolName === "powershell" ? inspectPowerShellCommand : inspectShellCommand;
    const unproven = commands.some((command) => inspect(command, shellInvocationCwd(ctx)).outcome === "unproven");
    if (!destructive && !unproven) return null;
    const level = !destructive && commands.length > 0 && commands.every((command) => REVERSIBLE_SHELL_RE.test(command)) ? "low" : "medium";
    return { level, reason: destructive ? "shell destructive floor: irreversible command" : "shell requires runtime evaluation" };
  },
  (ctx) => {
    if (ctx.category !== "shell") return null;
    const cmds = extractShellCommands(ctx.finalInput);
    if (cmds.length > 0 && cmds.every((cmd) => REVERSIBLE_SHELL_RE.test(cmd))) {
      return { level: "low", reason: "shell reversible verb" };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "shell") return null;
    return { level: "medium", reason: "shell unclassified" };
  },

  // Navigation URLs use the fetch request screen and escalate credentials/opaque data/oversized tails/userinfo. Other page actions are MEDIUM with session-only origin memory, never persistent authority.
  (ctx) => {
    if (ctx.source !== "builtin" || !isBrowserToolName(ctx.toolName)) return null;
    if (!isBrowserUrlToolName(ctx.toolName)) {
      return { level: "medium", reason: "browser page action" };
    }
    const screen = screenEgressRequest(ctx.finalInput);
    switch (screen.outcome) {
      case "screened":
        return { level: "high", reason: `${EXFIL_VERDICT_REASON_PREFIX} (${screen.signal})` };
      case "public-raw-ip":
        return { level: "medium", reason: PUBLIC_RAW_IP_FETCH_REASON };
      case "public-benign":
        return { level: "low", reason: "browser navigation to a public page" };
      case "not-public":
        return { level: "medium", reason: "browser navigation to a local or private address" };
    }
  },

  // Only web_fetch uses screened request verdicts; it retains network restrictions on unattended work, away-read authority and standing rules. Credential, oversized/opaque tail and userinfo evidence still escalates.
  (ctx) => {
    if (ctx.category !== "network") return null;
    if (ctx.source !== "builtin" || ctx.toolName !== SCREENED_EGRESS_TOOL) return null;
    const screen = screenEgressRequest(ctx.finalInput);
    switch (screen.outcome) {
      case "screened":
        return {
          level: "high",
          reason: `${EXFIL_VERDICT_REASON_PREFIX} (${screen.signal})`,
        };
      case "public-raw-ip":
        return { level: "medium", reason: PUBLIC_RAW_IP_FETCH_REASON };
      case "public-benign":
        return { level: "low", reason: PUBLIC_FETCH_REASON };
      // Not a public request: the rules below grade it exactly as before.
      case "not-public":
        return null;
    }
  },
  (ctx) => {
    if (ctx.category !== "network") return null;
    const target = extractNetworkTarget(ctx.finalInput);
    if (target?.host === "graph.microsoft.com") {
      if (isGraphMetadataRead(ctx.finalInput, target)) {
        return { level: "low", reason: "network graph metadata read" };
      }
      return { level: "medium", reason: "network graph data operation" };
    }
    const host = target?.host ?? null;
    if (host && isTrustedNetworkHost(host)) {
      return { level: "low", reason: `network trusted host (${host})` };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "network") return null;
    const host = extractNetworkHost(ctx.finalInput);
    if (host && LOCALHOST_HOSTS.has(host)) {
      return { level: "medium", reason: `network localhost (${host})` };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "network") return null;
    return { level: "high", reason: "network untrusted host" };
  },

  // Sandbox-write LOW requires a host-owned plugin root and every resolved path inside it. Escapes and declared-but-empty path fields must fall through to HIGH; plugin data isolation keeps these roots outside general allowed directories.
  (ctx) => {
    if (ctx.category !== "write") return null;
    if (!ctx.ownerPluginSandboxRoot) return null; // host-set; plugin-owned tools only
    const paths = extractDeclaredPaths(ctx);
    if (paths.length === 0) return null; // declared-but-empty → fall through to HIGH
    // Canonicalize the sandbox root on the producer's behalf so the
    // path-traversal defense holds even if a caller forgets to pre-
    // canonicalize. Both sides of the prefix compare are now bit-
    // identical canonical strings.
    const canonicalRoot = caseFoldForMatch(canonicalizePathForMatch(ctx.ownerPluginSandboxRoot));
    const allInside = paths.every((p) =>
      isInsideAllowed(p, [canonicalRoot]),
    );
    if (!allInside) return null;
    return { level: "low", reason: "write inside owner plugin sandbox" };
  },
  // Pathless plugin calls may use the kernel-enforced owning jail only when per-call host capability proves a live wrapped child/worker. Never infer confinement from manifests or the process-global runtime; in-process calls resolve unconfined.
  (ctx) => {
    if (ctx.category !== "write") return null;
    if (!ctx.ownerPluginSandboxRoot) return null; // host-set; plugin-owned tools only
    if (extractDeclaredPaths(ctx).length > 0) return null; // declared paths take the lexical rules
    if (!sandboxRelaxesCategory(ctx.sandboxCapability, "write")) return null;
    return { level: "low", reason: "no declared write path; OS-confined to owner plugin sandbox" };
  },
  // An unconfined plugin with no target is unknown, not proven dangerous: default write is a placeholder. Keep MEDIUM human consent rememberable; target-bearing calls still use lexical write rules, and host-owned plugin identity excludes builtin/server tools.
  (ctx) => {
    if (ctx.category !== "write") return null;
    if (ctx.source !== "plugin") return null;
    if (!ctx.ownerPluginSandboxRoot) return null; // host-set; plugin-owned tools only
    // Declared-but-unresolved is NOT the same as never declared. The auto-LOW
    // rule above states the promise this would otherwise break: a manifest that
    // declares `pathFields` and resolves to nothing "falls through to the
    // standard HIGH so manifest bugs do not silently downgrade verdicts". An
    // empty result also covers a non-string value, an empty string, and a
    // canonicalization throw — all of them reachable from the CALL's arguments,
    // which the plugin controls. Keying on the DECLARATION instead means an
    // argument cannot move a tool off the HIGH its manifest earned.
    if (ctx.pathFields.length > 0) return null;
    if (extractDeclaredPaths(ctx).length > 0) return null;
    return {
      level: "medium",
      requiresExplicitApproval: true,
      reason: "no declared write path; plugin category is a strict default, not an observation",
    };
  },
  (ctx) => {
    if (ctx.category !== "write") return null;
    const paths = extractDeclaredPaths(ctx);
    if (paths.length === 0) {
      return { level: "high", reason: "write path not declared" };
    }
    if (paths.some((p) => !isInsideAllowed(p, ctx.allowedDirectories))) {
      return { level: "high", reason: "write outside allowed dirs" };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "write") return null;
    return { level: "low", reason: "write at allowed-dir leaf" };
  },

  // Only named agent_spawn earns LOW: every child effect re-enters permission checks under the scoped registry and recursion blocklist. A category-wide meta exception would silently authorize unrelated present/future tools.
  (ctx) => {
    if (ctx.category !== "meta") return null;
    if (ctx.source !== "builtin" || ctx.toolName !== "agent_spawn") return null;
    return { level: "low", reason: "agent spawn (child tool effects gated separately)" };
  },
    // Status uses the shared read category so every gate agrees; no meta-only exception is needed.

  // read rules (2) — read shouldn't usually reach reviewer
  (ctx) => {
    if (ctx.category !== "read") return null;
    const paths = extractDeclaredPaths(ctx);
    if (paths.some((p) => !isInsideAllowed(p, ctx.allowedDirectories))) {
      return { level: "high", reason: "read outside allowed dirs" };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "read") return null;
    return { level: "low", reason: "read inside allowed dirs" };
  },
];

export class RuleBasedRiskClassifier implements RiskClassifier {
  classify(input: ToolInvocationContext): RiskVerdict {
    for (const rule of RULES) {
      const v = rule(input);
      if (v) return input.permissionReason === undefined ? v : { ...v, reason: input.permissionReason };
    }
    // Default fail-safe: MEDIUM (never silently LOW for an unknown shape).
    return { level: "medium", reason: "no rule matched (fail-safe medium)" };
  }
}

// LlmRiskClassifier

// Minimal LLM provider shim — the reviewer needs only a one-shot "complete prompt → JSON string + usage" call. The host's full VercelUnifiedProvider exposes `streamTurn`; this interface is the narrow surface a provider adapter exposes for synchronous single-shot risk classification.
export interface LlmCompletionResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface LlmReviewerProvider {
  complete(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    abortSignal?: AbortSignal;
  }): Promise<LlmCompletionResult>;
}

// Render a JSON object as a prompt-safe string with all secrets DLP-masked. Per-value: stringify, then run through `maskSensitiveData`. Truncate each value at 200 chars to keep prompts compact.
export function dlpRedactInputForPrompt(
  finalInput: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(finalInput)) {
    const raw = typeof v === "string" ? v : JSON.stringify(v ?? null);
    const { masked } = maskSensitiveData(raw);
    out[k] = masked.length > 200 ? masked.slice(0, 200) + "…" : masked;
  }
  return out;
}

function buildUserPrompt(
  input: ToolInvocationContext,
  ruleVerdict: RiskVerdict = new RuleBasedRiskClassifier().classify(input),
): string {
  const redacted = dlpRedactInputForPrompt(input.finalInput);
  const recentUserMessage = input.conversationContext?.recentUserMessage;
  const redactedContext =
    typeof recentUserMessage === "string" && recentUserMessage.trim().length > 0
      ? maskSensitiveData(recentUserMessage).masked.slice(0, 500)
      : undefined;
  // Use the same resolver and predicates as the rule classifier. This is evidence about declared operands, not an attestation about tool code.
  const declaredPaths = extractDeclaredPaths(input);
  const pathChecks = declaredPaths.map((path) => ({
    path,
    insideAllowedDirectories: isInsideAllowed(path, input.allowedDirectories),
    sensitiveRead: isSensitivePath(path, "read") !== null,
    sensitiveWrite: isSensitivePath(path, "write") !== null,
  }));
  const hostPolicyFacts = {
    ruleVerdict: input.permissionReason === undefined ? ruleVerdict
      : { ...ruleVerdict, reason: maskSensitiveData(input.permissionReason).masked },
    executionCwd: input.executionCwd.slice(0, 512),
    executionCwdTruncated: input.executionCwd.length > 512,
    declaredPathCount: declaredPaths.length,
    allDeclaredPathsInsideAllowedDirectories: pathChecks.length > 0 &&
      pathChecks.every((path) => path.insideAllowedDirectories),
    anyDeclaredPathSensitiveRead: pathChecks.some((path) => path.sensitiveRead),
    anyDeclaredPathSensitiveWrite: pathChecks.some((path) => path.sensitiveWrite),
    declaredPaths: pathChecks.slice(0, 8).map((check) => ({
      ...check,
      path: check.path.slice(0, 512),
      pathTruncated: check.path.length > 512,
    })),
    omittedDeclaredPathCount: Math.max(0, pathChecks.length - 8),
    explicitIntentPresent: !isContextMissingIntent(input),
  };
  // DLP remains a sink policy. Escape markup so path/reason strings cannot close the host-data block or introduce a second apparent control block.
  const hostFactsJson = maskSensitiveData(JSON.stringify(hostPolicyFacts)).masked
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const untrustedInput = (
    `tool: ${input.toolName}\n` +
    `source: ${input.source}\n` +
    `category: ${input.category}\n` +
    `pathFields: ${JSON.stringify(input.pathFields)}\n` +
    `trustOrigin: ${input.trustOrigin}\n` +
    `input (DLP-redacted): ${JSON.stringify(redacted)}\n` +
    `conversationContext (DLP-redacted): ${JSON.stringify(redactedContext ?? null)}\n` +
    `allowedDirectories: ${JSON.stringify(input.allowedDirectories.slice(0, 8))}\n` +
    `sensitivePathsAdjacent: ${JSON.stringify(input.sensitivePathsAdjacent.slice(0, 8))}\n` +
    `${formatSandboxCapabilityForPrompt(input.sandboxCapability)}\n`
  ).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<HOST_POLICY_FACTS>\n${hostFactsJson}\n</HOST_POLICY_FACTS>\n` +
    `<UNTRUSTED_INPUT>\n${untrustedInput}</UNTRUSTED_INPUT>`;
}

function tryParseVerdict(text: string): RiskVerdict | null {
  // Find the first balanced `{...}` — the SYSTEM prompt asks for "only JSON", but real LLMs occasionally wrap with a code-fence; tolerate that.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const level = obj.level;
  const reason = obj.reason;
  if (
    (level !== "low" && level !== "medium" && level !== "high") ||
    typeof reason !== "string"
  ) {
    return null;
  }
  const trimmed = reason.length > 80 ? reason.slice(0, 80) : reason;
  return { level, reason: trimmed };
}

export type FallbackOnError = "deny" | "rule";

// Retry policy for the LLM provider call inside `classify`. Transient failures (network blip, rate limit, 5xx) are retried with exponential back-off + jitter; deterministic failures (parse error, abort, 4xx client errors) are NOT retried. Defaults are chosen so the user-visible worst-case latency (~1s for 3 attempts at 250ms / 500ms with jitter) stays well under the approval dock's perceptual threshold while still absorbing a single transient flap. Issue: — before this wiring, every provider failure went straight to `fallbackOnError`, so users saw spurious "denied" verdicts on any network glitch even when a retry would have succeeded.
export interface LlmReviewerRetryConfig {
  // Total attempts including the first try. 1 = no retry. Clamped >= 1.
  maxAttempts: number;
  // Initial delay before the FIRST retry (ms). Doubles each attempt.
  baseDelayMs: number;
  // Jitter % applied to each delay (0-100). 25 → ±25% multiplicative.
  jitterPct: number;
}

export const DEFAULT_REVIEWER_RETRY: LlmReviewerRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 250,
  jitterPct: 25,
};

export interface LlmRiskClassifierTelemetry {
  onCall?(stats: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    parseFailed: boolean;
    // Total LLM provider invocations including retries. 1 = success on first try.
    attempts?: number;
  }): void;
}

// Sleep that resolves early when the abort signal fires. Returns whether the sleep completed normally (true) or was aborted (false). Used so a user-cancel during a retry back-off does not block the cancel UX behind the remaining sleep window.
async function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return true;
  if (signal?.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      // Microtask-race guard: the abort event may fire AFTER setTimeout queued this callback but BEFORE it executed. In that window `clearTimeout` is a no-op and `onAbort.resolve(false)` races our `resolve(true)`. Re-check the signal here so the sleep honestly reports completion vs abort.
      resolve(!signal?.aborted);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Classify a provider error as transient (worth retrying) vs terminal. Terminal: abort (user cancel), 4xx-client (other than rate limit), parse issues (those are handled separately, never reach this). Transient: 5xx, 429 rate limit, network/timeout flap, AggregateError, unknown error shapes (conservative: prefer to retry rather than fail fast when we don't know — bounded by maxAttempts).
function isTransientReviewerError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    const msg = err.message.toLowerCase();
    if (msg.includes("aborted")) return false;
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("rate-limit")) return true;
    if (/\b5\d{2}\b/.test(msg)) return true; // 5xx
    if (msg.includes("etimedout") || msg.includes("econnreset") || msg.includes("enotfound") ||
        msg.includes("econnrefused") || msg.includes("network") || msg.includes("fetch failed") ||
        msg.includes("timeout") || msg.includes("socket")) {
      return true;
    }
    // Explicit 4xx (not 429) → terminal
    if (/\b4\d{2}\b/.test(msg)) return false;
  }
  // Conservative default: retry. maxAttempts bounds the blast.
  return true;
}

// Bypass model review only for host-proven names with matching expected categories: spawn rechecks child effects, status reads scoped host bookkeeping, and list accepts no args and exposes only profiles/this conversation's children. Category drift loses the bypass; all other tools keep composed review.
const HOST_DETERMINED_RISK_TOOLS: ReadonlyMap<string, ToolCategory> = new Map([
  ["agent_spawn", "meta"],
  ["agent_status", "read"],
  ["agent_list", "read"],
]);

function isHostDeterminedRiskTool(input: ToolInvocationContext): boolean {
  // Co-scoped with the rule that justifies each bypass (category included): those LOW rules key on (category, source, toolName), and keying the bypass on fewer axes would let a category drift hand the final verdict to a DIFFERENT rule with no LLM cross-check.
  if (input.source !== "builtin") return false;
  return HOST_DETERMINED_RISK_TOOLS.get(input.toolName) === input.category;
}

export class LlmRiskClassifier implements RiskClassifier {
  private readonly rule = new RuleBasedRiskClassifier();

  constructor(
    private readonly provider: LlmReviewerProvider,
    private readonly model: string,
    private readonly fallbackOnError: FallbackOnError = "deny",
    private readonly telemetry: LlmRiskClassifierTelemetry = {},
    private readonly retry: LlmReviewerRetryConfig = DEFAULT_REVIEWER_RETRY,
  ) {}

  reviewUserOwnedSurface(input: UserOwnedSurfaceReviewInput, signal?: AbortSignal): Promise<UserOwnedSurfaceReviewResult> {
    return reviewUserOwnedSurface(this.provider, this.model, input, signal);
  }

  // Run `provider.complete` with bounded retry on transient errors. Returns the attempt count on success so telemetry can record it. Throws the LAST error on exhaustion or on the first terminal error. Honors `abortSignal` at every sleep boundary so user-cancel is not blocked.
  private async runProviderWithRetry(
    userPrompt: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<{ completion: Awaited<ReturnType<LlmReviewerProvider["complete"]>>; attempts: number }> {
    // Clamp config defensively: the caller may pass an unvalidated config from settings or a future runtime knob — `maxAttempts > 10` would risk retry storms, `jitterPct > 100` would collapse to zero-delay retry through `Math.max(0, …)`, `jitterPct < 0` would invert direction. Hard ceilings + floors prevent both.
    const maxAttempts = Math.max(1, Math.min(10, this.retry.maxAttempts));
    const jitterPct = Math.max(0, Math.min(100, this.retry.jitterPct));
    const baseDelayMs = Math.max(0, this.retry.baseDelayMs);
    let lastErr: unknown = new Error("unreachable");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Note: deliberately do NOT short-circuit on `abortSignal.aborted` before calling complete. The provider is the canonical owner of abort handling and tests rely on the provider seeing the signal even when it was already-aborted at entry — preserves the pre-contract.
      try {
        const completion = await this.provider.complete({
          model: this.model,
          systemPrompt: PERMISSION_REVIEWER_SYSTEM_PROMPT,
          userPrompt,
          abortSignal,
        });
        return { completion, attempts: attempt };
      } catch (err) {
        lastErr = err;
        if (attempt >= maxAttempts) break;
        if (!isTransientReviewerError(err)) break;
        // Exponential back-off with multiplicative jitter (±jitterPct). Only the SLEEP between retries is signal-aware — if the user cancels during back-off we honour it immediately rather than making them wait out the remaining window.
        const base = baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = 1 + ((Math.random() * 2 - 1) * jitterPct) / 100;
        const delay = Math.max(0, Math.round(base * jitter));
        const completed = await abortableSleep(delay, abortSignal);
        if (!completed) {
          throw new Error("aborted");
        }
      }
    }
    throw lastErr;
  }

  // MEDIUM: accepts optional abortSignal so callers (dispatchReviewer, interactive approval flow) can cancel an in-flight LLM call when the user cancels the operation. The second parameter is not part of the RiskClassifier interface (which is intentionally signal-agnostic) but is called directly by callers that have a signal available.
  async classify(
    input: ToolInvocationContext,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<RiskVerdict> {
    const trace = await this.classifyWithTrace(input, opts);
    return trace.finalVerdict;
  }

  // Audit callers need the raw rule + LLM verdicts separately from the composed final verdict. The public RiskClassifier interface remains the final-verdict-only surface so non-LLM classifiers stay simple.
  async classifyWithTrace(
    input: ToolInvocationContext,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<LlmRiskClassificationTrace> {
    // Composition baseline — rule first, LLM cannot downgrade.
    const ruleVerdict = this.rule.classify(input);

    // Host-determined tools never consult the LLM: their risk is settled by system structure, not by anything a model could weigh. For agent_spawn the structural fact is that every effectful call the child makes re-enters this same permission pipeline — a fact that is not in the reviewer prompt, so asking the LLM poses a question it cannot answer; it kept replying HIGH ("no sandbox isolation, file access") and the max(rule, llm) composition let that guess override the host's LOW. Name-scoped and builtin-only: a plugin/MCP tool that happens to share the name still takes the full composed path.
    if (isHostDeterminedRiskTool(input)) {
      return { ruleVerdict, llmVerdict: null, finalVerdict: ruleVerdict, outcome: "host-determined" };
    }

    // Composition-pinned HIGH: the final verdict is maxVerdict(rule, llm) and HIGH is the top of the scale, so once the RULE verdict is HIGH the provider round-trip cannot change the outcome — the LLM can only raise or tie (a tie merely swaps the reason text). It only adds seconds in front of a modal the user is already going to see — and HIGH is un-persistable, so that cost recurred on EVERY invocation of the same tool. Skip the call. If composition ever gains a genuine downgrade path, this early-return must be re-derived alongside it.
    if (
      ruleVerdict.level === "high" ||
      ruleVerdict.requiresExplicitApproval === true
    ) {
      // "host-determined" is the existing outcome for exactly this semantic: the rule verdict is final by construction and the LLM was never consulted (see ReviewerDispatchOutcome). `requiresExplicitApproval` joins HIGH here for two reasons. The call is going to a person either way, so the round trip cannot change the outcome — the same argument the paragraph above makes for HIGH. And `maxVerdict` returns ONE of the two verdicts whole: an LLM verdict at the SAME level wins the tie and would carry the flag away with it, silently re-opening (b) and (c). Not asking is what keeps that from being possible rather than merely unlikely.
      return { ruleVerdict, llmVerdict: null, finalVerdict: ruleVerdict, outcome: "host-determined" };
    }

    let llmVerdict: RiskVerdict;
    try {
      const userPrompt = buildUserPrompt(input, ruleVerdict);
      const { completion, attempts } = await this.runProviderWithRetry(
        userPrompt,
        opts?.abortSignal,
      );
      const parsed = tryParseVerdict(completion.text);
      this.telemetry.onCall?.({
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
        costUsd: completion.costUsd,
        parseFailed: parsed === null,
        attempts,
      });
      if (parsed === null) {
        // Parse failure → fallbackOnError policy
        if (this.fallbackOnError === "deny") {
          const finalVerdict = { level: "high", reason: "llm parse failure — fallbackOnError=deny" } as const;
          return { ruleVerdict, llmVerdict: finalVerdict, finalVerdict, outcome: "malformed" };
        }
        return { ruleVerdict, llmVerdict: null, finalVerdict: ruleVerdict, outcome: "malformed" };
      }
      llmVerdict = parsed;
    } catch (err) {
      // Any provider error (after retry exhaustion or terminal-classified) → fallbackOnError policy. Surface the worst-case attempt count to telemetry so dashboards can distinguish first-try-failure from retry-exhaustion; the exhaustion rate is the signal that matters for provider reliability.
      this.telemetry.onCall?.({
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        parseFailed: true,
        attempts: Math.max(1, Math.min(10, this.retry.maxAttempts)),
      });
      if (this.fallbackOnError === "deny") {
        // DLP-mask the provider error message before embedding into the verdict reason: provider errors sometimes echo request body fragments back, which would otherwise land in audit logs + UI without redaction.
        const rawMsg = err instanceof Error ? err.message ?? "error" : "error";
        const { masked } = maskSensitiveData(rawMsg);
        const msg = masked.slice(0, 60);
        const finalVerdict = { level: "high", reason: `llm error — fallback=deny (${msg})` } as const;
        const outcome = reviewerFailureOutcome(err);
        return { ruleVerdict, llmVerdict: finalVerdict, finalVerdict, outcome };
      }
      const outcome = reviewerFailureOutcome(err);
      return { ruleVerdict, llmVerdict: null, finalVerdict: ruleVerdict, outcome };
    }

    // Context-quality + per-category sandbox composition enforcement: The sandbox relaxation is now per-CATEGORY — it applies only when the capability's `confines` dimension that covers this call's category is genuinely jailed (network risk ↔ confines.network; filesystem-bearing write/shell/read/meta ↔ confines.filesystem). When the sandbox does NOT relax this category, OR conversation context lacks explicit intent, prevent the LLM from downgrading a rule-based MEDIUM/HIGH verdict to LOW.
    const sandboxRelaxes = sandboxRelaxesCategory(input.sandboxCapability, input.category);
    const weakContext = isContextMissingIntent(input);
    if (!sandboxRelaxes || weakContext) {
      if (LEVEL_RANK[llmVerdict.level] < LEVEL_RANK[ruleVerdict.level]) {
        // LLM attempted to downgrade — honour the rule verdict.
        return { ruleVerdict, llmVerdict, finalVerdict: ruleVerdict, outcome: "fresh" };
      }
    }

    return { ruleVerdict, llmVerdict, finalVerdict: maxVerdict(ruleVerdict, llmVerdict), outcome: "fresh" };
  }
}

// Factory

export type ReviewerMode = "disabled" | "llm";

export interface ReviewerSettings {
  mode: ReviewerMode;
  // Required when mode === "llm".
  provider?: LlmReviewerProvider;
  // Required when mode === "llm"; an unset model is not configured.
  model?: string;
  // Defaults to "deny" so reviewer provider failures fail closed.
  fallbackOnError?: FallbackOnError;
  telemetry?: LlmRiskClassifierTelemetry;
}

// Boot-time factory. Throws when `mode === "llm"` is configured but the provider is missing — atomic cutover, no fallback shim.
export function createRiskClassifier(settings: ReviewerSettings): RiskClassifier {
  switch (settings.mode) {
    case "disabled":
      return new DisabledRiskClassifier();
    case "llm": {
      if (!settings.provider) {
        throw new Error(
          `permissions.reviewer.mode = 'llm' but no provider configured. ` +
          `Set provider via createRiskClassifier({mode:'llm', provider, model}). ` +
          `(Permission policy P3 atomic cutover — no silent fallback to rule-based.)`,
        );
      }
      const model = settings.model?.trim();
      if (!model) throw new Error("Permission reviewer model not configured.");
      const fb = settings.fallbackOnError ?? "deny";
      if (fb !== "deny" && fb !== "rule") {
        throw new Error(
          `permissions.reviewer.fallbackOnError must be 'deny' or 'rule' — got '${fb}'. ` +
          `(Spec v2.1 §3 Layer 5: 'allow-and-audit' enum removed.)`,
        );
      }
      return new LlmRiskClassifier(
        settings.provider,
        model,
        fb,
        settings.telemetry,
      );
    }
    default: {
      const _exhaustive: never = settings.mode;
      void _exhaustive;
      throw new Error(`Unknown reviewer mode: ${String(settings.mode)}`);
    }
  }
}

// Internal exports for unit tests.
export const _internal = { buildUserPrompt, tryParseVerdict, RULES, PERMISSION_REVIEWER_SYSTEM_PROMPT, isContextMissingIntent };
