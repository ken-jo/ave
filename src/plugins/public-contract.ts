/**
 * Host-owned public contract for Ave plugin authors.
 *
 * This module is the sole source of the plugin-facing type surface and its
 * JSDoc. Keep runtime-only registry and marketplace persistence declarations in
 * `types.ts`. Two things read it mechanically and add nothing of their own: a
 * plugin repository vendors it unchanged at an app release tag into
 * `contract/`, hash-checked; and `scripts/lib/plugin-host-protocol-schema.ts`
 * reads its `PluginHostApi` member types into the host protocol schema.
 */

/**
 * Modules supplied by the Host process and therefore excluded from plugin
 * runtime bundles. The Host owns this value; plugin build helpers consume the
 * vendored constant without adding policy.
 */
export const HOST_EXTERNAL_MODULES = ["electron"] as const;

/**
 * Browser packages tracked by the Host build policy. Current plugin UI bundles
 * remain self-contained because {@link BUNDLE_EVERYTHING_REGEX} takes
 * precedence in the build helper; these names are retained as the explicit
 * Host-owned boundary for a future shared-browser-runtime contract.
 */
export const HOST_BROWSER_EXTERNAL_MODULES = ["react", "react-dom"] as const;

/**
 * Host-owned match-all policy used to bundle every dependency not explicitly
 * supplied by the Host.
 */
export const BUNDLE_EVERYTHING_REGEX = new RegExp(".*");

/**
 * Agent Plugins 1.0.0 manifest schema identifier (agent-plugins.org). A
 * `plugin.json` MUST carry this exact string in `$schema`; the schema pins it
 * as a `const`, so it doubles as the manifest-format marker.
 */
export const AGENT_PLUGINS_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/**
 * The reverse-domain namespace Ave owns inside the portable `extensions`
 * object: Ave's web home `ave.agent-connector.ai`, reversed. Agent Plugins assigns no semantics to a
 * namespace's contents, so everything the host needs in order to load, sandbox
 * and govern a plugin lives under this one key.
 */
export const AVE_EXTENSION_NAMESPACE = "ai.agent-connector.ave";

/**
 * The plugin id grammar: the manifest `name` rule of
 * `schemas/plugin-manifest.schema.json` (kebab-case, no `--`, 3–64
 * characters), which the host reads as `PluginManifest.id`. Every host
 * surface that accepts a plugin id checks it here, so an id can only be
 * valid everywhere or nowhere.
 */
export const PLUGIN_ID_PATTERN = /^(?!.*--)[a-z][a-z0-9-]*[a-z0-9]$/u;
export const PLUGIN_ID_MIN_LENGTH = 3;
export const PLUGIN_ID_MAX_LENGTH = 64;

export function isValidPluginId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= PLUGIN_ID_MIN_LENGTH
    && value.length <= PLUGIN_ID_MAX_LENGTH
    && PLUGIN_ID_PATTERN.test(value);
}

/** The non-executable branch of the portable manifest at a marketplace boundary. */
export interface AgentPluginPackageManifest {
  $schema: typeof AGENT_PLUGINS_SCHEMA_URL;
  name: string;
  version: string;
  description: string;
  extensions?: Record<string, unknown> & {
    "ai.agent-connector.ave"?: {
      displayName?: string;
      icon?: string;
      iconText?: string;
      requires?: { minAppVersion: string };
      process?: PluginProcessEntry;
      mcpAuth?: Record<string, { auth: "api-key"; apiKeyEnv?: string; apiKeyHeader?: string }>;
    };
  };
}

/**
 * The top level Agent Plugins 1.0.0 defines. Anything else up there belongs to
 * no one, and the specification is explicit that a client reports and ignores
 * it rather than refusing the plugin.
 */
export const AGENT_PLUGINS_TOP_LEVEL_FIELDS: readonly string[] = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
];

/**
 * Top-level fields of a manifest document that Agent Plugins 1.0.0 does not
 * define. Separated from {@link flattenAgentPluginsManifest} so the projection
 * stays pure: the specification's "report and ignore" is two obligations, and
 * only the reporting half needs somewhere to report to.
 */
export function foreignManifestTopLevelFields(document: unknown): string[] {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return [];
  }
  return Object.keys(document as Record<string, unknown>).filter(
    (key) => !AGENT_PLUGINS_TOP_LEVEL_FIELDS.includes(key),
  );
}

/**
 * Convert an on-disk Agent Plugins 1.0.0 document into the flat
 * {@link PluginManifest} every consumer reads.
 *
 * This is the one definition of where each field lives in the file. It is in
 * the public contract, not beside the host's validator, because plugin repos
 * read their own `plugin.json` too — in tests, in event validators, in install
 * scripts. Seven repos each writing their own projection is seven chances for
 * the copies to disagree about, say, whether identity is `name` or `id`.
 *
 * The portable `name` lands on `id` and `extensions["ai.agent-connector.ave"]` is spread
 * flat, with its `displayName` becoming the internal `name` — which is why
 * consumers do not know the file on disk is nested.
 *
 * Pure and total: a document of the wrong shape is passed through, so a caller
 * that validates gets an error naming the actual defect rather than one thrown
 * from here first.
 *
 * Portable metadata (`author`, `homepage`, `repository`, `license`,
 * `keywords`) is deliberately NOT projected. It is catalog-facing, and this
 * contract keeps catalog concepts out of the plugin manifest. Only `version`
 * and `description`, which the host itself acts on, cross over.
 */
export function flattenAgentPluginsManifest(document: unknown): PluginManifest {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return document as PluginManifest;
  }
  const top = document as Record<string, unknown>;
  const extensions = top.extensions;
  const namespaced =
    extensions && typeof extensions === "object" && !Array.isArray(extensions)
      ? (extensions as Record<string, unknown>)[AVE_EXTENSION_NAMESPACE]
      : undefined;
  const hostBlock =
    namespaced && typeof namespaced === "object" && !Array.isArray(namespaced)
      ? (namespaced as Record<string, unknown>)
      : {};
  const { displayName, ...hostFields } = hostBlock;
  const flat: Record<string, unknown> = {
    ...hostFields,
    id: top.name,
    version: top.version,
    description: top.description,
  };
  if (displayName !== undefined) flat.name = displayName;
  // Pre-validation: the assertion states the shape the caller is about to
  // prove, not one already proven.
  return flat as unknown as PluginManifest;
}

/** One signed first-party `ui://` resource declaration. */
export interface PluginUiResourceDecl {
  uri: string;
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  /**
   * Intentionally narrower than the protocol-wide MCP wire type: the
   * manifest may declare only features the Host can demonstrably grant.
   */
  permissions?: {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
  };
}

/** Host-enforced minimum risk for one discriminated plugin operation. */
export type GovernedRiskFloor = "read" | "write" | "network" | "shell";

/** Host-owned operation rule carried in the vendored public contract. */
export interface PluginToolOperationRule {
  kind: "read" | "write";
  minimumRisk: GovernedRiskFloor;
  /** Permit this operation from an app only when the parent Tool is app-visible. @optional */
  appVisible?: boolean;
  /**
   * For a read that resolves with a structured domain result, the top-level
   * `status` value(s) that are allowed to mint Host freshness. When declared,
   * a missing, non-string, or unlisted status fails closed while the result
   * remains visible to the caller. Valid only when `kind` is `"read"`.
   * @optional
   */
  successfulResultStatuses?: string[];
  requiresRead?: {
    tool: string;
    operations: string[];
    maxAgeMs: number;
  };
}

/** Signed per-operation restrictions colocated on the owning MCP Tool. */
export interface PluginToolOperationPolicy {
  discriminant: "operation";
  operations: Record<string, PluginToolOperationRule>;
}

export type AuthWindowCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
};

/**
 * A cookie returned by `getAuthPartitionCookies` — carries the value (that is
 * the point of the gated read) plus the attributes a browser-context injector
 * needs. Only a plugin that harvested the session owns the partition it reads.
 */
export type AuthPartitionCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** Unix seconds. Omitted for session cookies. */
  expirationDate?: number;
};

export type OpenAuthWindowBaseOptions = {
  url: string;
  completionUrlPatterns: string[];
  cookieHosts: string[];
  timeoutMs?: number;
  windowTitle?: string;
  persistPartition?: string;
  /**
   * Whether the auth window is rendered visibly. Default `true` for
   * interactive logins (the user must see + interact with the IdP page).
   * Set to `false` for silent-SSO warmups where the page is expected to
   * complete via residual IdP cookies in `persistPartition` and never
   * requires user input — the BrowserWindow still loads + harvests
   * cookies + emits navigation events but is never shown.
   *
   * `show: false` MUST pair with an explicit `timeoutMs` so a hidden
   * SSO challenge (captcha, MFA prompt) cannot hang the warmup forever
   * invisible to the user.
   *
   * @default true
   */
  show?: boolean;
  /**
   * Session-cookie vault mode. When `true`, harvested cookie VALUES are
   * withheld from the return — each returned cookie keeps its name/domain/path
   * (so existence and count checks still work) but its `value` is `""`. The
   * real values remain only in the persistent `persistPartition`, from which
   * `hostFetch` attaches them per request when the plugin also declares
   * `networkAccess.authCookiePartition`.
   *
   * For portals with no SSO/OAuth — where the session cookie IS the credential
   * — this keeps that credential on the host, never in the plugin bundle.
   *
   * @default false
   */
  retainCookies?: boolean;
};

export type OpenAuthWindowWithFinalUrlOptions = OpenAuthWindowBaseOptions & {
  returnFinalUrl: true;
};

export type OpenAuthWindowCookieOptions = OpenAuthWindowBaseOptions & {
  returnFinalUrl?: false | undefined;
};

export type OpenAuthWindowFinalUrlResult = {
  cookies: AuthWindowCookie[];
  finalUrl: string;
};

/** Query parameters of an exact-path, host-state-validated OAuth callback, including provider errors. */
export type AuthRedirectParams = Readonly<Record<string, string>>;

export type AuthRedirectOpenResult = {
  /** Names the listener. It is not the listener, and it is not transferable. */
  handle: string;
  /**
   * `http://localhost:<port>`. The spelling matters: identity providers
   * register loopback redirect URIs by HOST and allow any port, so
   * `127.0.0.1` would be a different — unregistered — URI.
   */
  redirectUri: string;
  /** Fresh host-generated single-use state. Send unchanged with PKCE S256 in the authorization request. */
  state: string;
};

export interface DependencySpec {
  pluginId: string;
  versionRange?: string;
  required?: boolean;
}

export interface PluginAccessTarget {
  pluginId: string;
  events?: string[];
}

export interface PluginAccessSpec {
  plugins: PluginAccessTarget[];
  /**
   * §8 P0 security — approval action scopes this plugin is permitted to
   * issue via `requestAgentApproval()` / `hostApi.agentApproval.respond()`.
   *
   * Defaults to empty array (no approval scopes allowed) when omitted.
   * The host verifies at respond-time that the issuer's declared scopes
   * include the scope recorded at request-time — violations throw
   * ApprovalOriginError (no silent fallback).
   *
   * Known scopes: "agent_file_share", "agent_task_delegate", "agent_external_api_call"
   */
  agentApprovalScopes?: string[];
}

export interface PluginAuthSpec {
  /** Human-readable label shown next to the badge (defaults to plugin `name`). */
  label?: string;
  /**
   * Per-language overrides of `label`, keyed by a normalized lower-case
   * BCP-47 tag; resolved like {@link PluginUiExtension.locales}
   * (exact tag → base language → own `label` → the plugin name).
   * @optional
   */
  locales?: Record<string, { label: string }>;
  /** Name of an app-visible tool returning {@link PluginAuthStatus}. */
  statusTool: string;

  loginTool: string;

  logoutTool?: string;
  /**
   * Hostname allow-list (suffix-match) for `hostApi.openAuthPartitionViewer`.
   * Required when the plugin calls that method — host rejects calls if this
   * field is missing or the target URL host falls outside the list.
   *
   * Each entry must contain at least one dot; wildcards, single-label hosts,
   * bare public-suffix entries (`com`, `co.kr`, …), and IDN-punycode labels
   * (`xn--*`) are refused at manifest load time. Up to 16 entries. Suffix
   * match is dot-boundary (`webmail.example.com` allows
   * `mail.webmail.example.com` but not `webmail.example.com.attacker.com`).
   *
   * See `docs/references/plugin-tool-schema-design.md` §2.4.1 for the full
   * contract (rejection table, three-layer defense, worked example).
   */
  partitionDomains?: string[];
}

/**
 * Recommended return shape of `auth.statusTool`. Host parses with a strict
 * identity check: `result?.authenticated === true`. Plugins MUST return the
 * literal boolean `true` — truthy values such as `1` or the string `"true"`
 * are NOT accepted (string `"false"` is truthy in JS and would be
 * misclassified by `Boolean()`). Account is read as a string when present.
 * The shape is documented but not AJV-validated in v1 — outputSchema
 * validation is a separate cross-cutting change. Plugins MAY return
 * additional fields; the host ignores them.
 */
export interface PluginAuthStatus {
  authenticated: boolean;
  /** Human-readable identity (email, login id) shown next to the green badge. */
  account?: string;
}

export interface EventSubscriptionHint {
  category:
    | "task" | "note" | "session" | "meeting" | "email" | "calendar" | "system";
  priority: "high" | "medium" | "low";
  title: string;
}

export interface EventSubscription {
  type: string;
  hint?: EventSubscriptionHint;
}

/* ============================================================================
 * Plugin Contract v6 (#885) — pure MCP `Tool` object surface.
 *
 * These types define the v6 "manifest == wire" tool contract. There is no legacy
 * triple — no `string[]` tool list, no separate `toolSchemas`, no per-tool
 * app-action map:
 * `PluginManifest.tools` is `Tool[]` and every host consumer reads surface
 * visibility off each tool's `_meta.ui.visibility` (materialized once at manifest
 * load by `parsePluginJson`). Plugin repositories vendor this public contract
 * unchanged at an app release tag.
 * ==========================================================================*/
/**
 * A tool a plugin exposes — the pure MCP `Tool` object (manifest == wire, §2.1/§2.2).
 * `inputSchema`/`outputSchema` use JSON Schema dialect 2020-12 (the RC default when
 * `$schema` is omitted). Ave authoring subset of the pinned MCP `Tool`: the MCP
 * `annotations` field is intentionally NOT authorable (untrusted self-claim); the
 * host derives its own interop annotations at projection time. `outputSchema` IS
 * authorable (standard, harmless).
 */
export interface Tool {
  /** LLM/UI tool name. Must match `^[a-zA-Z_][a-zA-Z0-9_]*$` (≤64). */
  name: string;
  /** Optional human display title. @optional */
  title?: string;
  /** LLM-facing description (when/what/returns). ≥10 chars when present. @optional */
  description?: string;
  /** JSON Schema 2020-12 input schema. */
  inputSchema: {
    $schema?: string;
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** Optional JSON Schema 2020-12 structured-output schema (standard MCP field). @optional */
  outputSchema?: {
    $schema?: string;
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** MCP icons (2025-11-25). @optional */
  icons?: Array<{ src: string; mimeType?: string; sizes?: string }>;
  /**
   * Surface visibility + Ave restriction metadata. Recognized keys: the
   * standard `ui` visibility block, `ave/pathFields`, and the signed
   * `ave/operationPolicy`. Any other key — including the removed legacy reverse-DNS
   * spelling of `ave/pathFields` — is rejected by the manifest schema (fail-closed). @optional
   */
  _meta?: {
    /** SEP-1865 surface visibility. @optional */
    ui?: { visibility?: Array<"model" | "app"> };
    /**
     * Input-schema argument names whose values are filesystem paths, fed into the
     * HOST-side allowed-directories check. Dotted names address nested object
     * fields. Untrusted routing hint: a lying declaration only ADDS host checks,
     * never bypasses one. @optional
     */
    "ave/pathFields"?: string[];
    /** Operation-level risk/read constraints; restrictions only, never authority expansion. @optional */
    "ave/operationPolicy"?: PluginToolOperationPolicy;
  };
}

/**
 * An executable that speaks the host protocol itself, in any language
 * (docs/design/plugin-hostapi-protocol.md §2.1).
 *
 * `command` is a `./` or `${PLUGIN_ROOT}/` path inside the plugin root, never a
 * bare name: a marketplace plugin gets no `PATH` search. `${PLUGIN_ROOT}/…` and
 * `${PLUGIN_DATA}…` are expanded in `args` and `env`, and the host sets both
 * variables in the process's environment.
 */
export interface PluginProcessEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Declarative plugin metadata validated by the Host before plugin code loads,
 * less the field that says how its process is produced.
 *
 * `tools` is the only callable surface. Legacy `uiTool`, `uiTools`, `uiAction`,
 * `uiActions`, top-level `operationGovernance`, and top-level `appAllowed`
 * declarations are invalid and rejected by the Host-owned manifest schema.
 */
export interface PluginManifestFields {

  id: string;
  /**
   * Human-readable display name. Schema-OPTIONAL (#885 v6): an authored manifest
   * may omit it. `parsePluginJson` materializes `name ?? id` at load, so a parsed
   * manifest always carries a name at runtime; consumers that may also see an
   * unparsed manifest fall back to `name ?? id`.
   */
  name?: string;
  version: string;



  /** Pure MCP `Tool` objects (manifest == wire). Surface visibility lives in each
   *  tool's `_meta.ui.visibility`; there is no separate app-action map or schema map. */
  tools: Tool[];

  /** Required one-line summary used in Host UI and model plugin catalogs. */
  description: string;
  /** Declarative, inert first-run guidance rendered by the host. */
  onboarding?: PluginOnboardingSpec;
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  /**
   * MCP App `ui://` resources this plugin serves — the plugin→host serving
   * contract for interactive HTML cards (distinct from `ui[]`, which declares
   * host-mounted React sidebar panels). Each entry declares a
   * `ui://<pluginId>/<path>` uri plus that resource's OWN `_meta.ui` security
   * POLICY (its csp). The CONTENT is served by the plugin itself
   * ({@link RuntimePlugin.readUiResource}) — "declared policy, served content".
   *
   * When a tool result carries `_meta.ui.resourceUri` matching one of these uris,
   * the loopback host asks the plugin for the card HTML and renders it through the
   * same sandbox-proxy + main-computed CSP path as an external MCP server's
   * `ui://` resource. See {@link PluginUiResourceDecl} for the security invariants
   * (own-namespace-only, declared-only, host-computed CSP). @optional
   */
  uiResources?: PluginUiResourceDecl[];

  /** Plugin-owned instruction bundles, rooted at a directory containing SKILL.md. */
  skills?: PluginContributionDeclaration[];
  /** Plugin-owned declarative Hook configuration files. Presence does not grant trust. */
  hooks?: PluginContributionDeclaration[];
  /** Plugin-owned declarative MCP server configuration files. Presence does not grant approval. */
  mcpServers?: PluginContributionDeclaration[];
  /** Plugin-owned prompt files. Their text retains package-authored provenance. */
  prompts?: PluginContributionDeclaration[];
  /** Plugin-owned routine suggestion files. Installation never creates a routine. */
  routineTemplates?: PluginContributionDeclaration[];



  capabilities?: string[];
  /**
   * Tier A egress allow-list (§9.x). Host-mediated egress (`hostApi.hostFetch`)
   * and explicitly documented browser/direct intranet exceptions may only reach
   * hosts matching `allowedDomains` (dot-boundary suffix match — see
   * `host-allow-list.ts`). Deny-by-default: absent or empty ⇒ no egress is
   * permitted. `reasoning` is a human-readable justification surfaced to the
   * user at install for broad grants.
   *
   * The loopback literals `localhost`, `127.0.0.1` and `::1` may be declared
   * here (exact literals only — `foo.localhost` goes through the normal rules).
   * Declaring one is what lets a plugin reach a local endpoint the user
   * configured, cleartext http included, since those bytes never leave the
   * machine; the host still proves the name resolves to loopback before
   * allowing it, and the grant extends to nothing else.
   */
  networkAccess?: {
    allowedDomains: string[];
    reasoning?: string;
    /**
     * Declarative, user-approved governance opt-in for reaching private-network
     * (RFC1918 / ULA) allow-listed hosts through host-mediated egress or an
     * explicitly documented browser/direct intranet exception. Link-local and
     * metadata addresses remain denied by host guards; loopback is a separate
     * axis this flag neither grants nor requires — see `allowedDomains` above.
     */
    allowPrivateNetworks?: boolean;
    /**
     * Opt-in: the sub-namespace of this plugin's own auth partition
     * (`persist:plugin-auth:<pluginId>:<sub>`) whose harvested session cookies
     * the host attaches to every `hostFetch` request, scoped per URL.
     *
     * For portals that offer no SSO/OAuth — where the session cookie IS the
     * credential — this keeps the harvested cookie VALUES on the host: the
     * plugin declares `authCookiePartition: "<sub>"`, `openAuthWindow` writes
     * the session into `persist:plugin-auth:<pluginId>:<sub>`, and `hostFetch`
     * reads it back from there. The plugin bundle never sees the value. A
     * plugin that declares this MUST NOT also send its own `Cookie` header
     * (the host rejects a request that does — single injection origin).
     *
     * The value is only the `<sub>` segment; the host composes the full
     * `persist:plugin-auth:<pluginId>:<sub>` partition, so a plugin cannot
     * name another plugin's partition here.
     */
    authCookiePartition?: string;
  };



  eventSubscriptions?: string[] | EventSubscription[];



  auth?: PluginAuthSpec;



  emittedEvents?: string[];



  /**
   * Recommended-work channel declaration — which KINDS of work proposal this
   * plugin may post to the host's Work Board via
   * {@link PluginHostApi.proposeWork}.
   *
   * DECLARATION IS AUTHORIZATION, and there is no capability string to add: a
   * plugin authorizes itself to propose in `stale-index` by DECLARING
   * `stale-index` here, exactly as it authorizes an `email.*` emit by
   * declaring an `email.*` entry in `emittedEvents`. Absent or empty ⇒ the
   * plugin may post nothing; `proposeWork` resolves `kind_not_granted`.
   *
   * THE DECLARED LIST IS ALSO THE NAG CEILING. A plugin may hold AT MOST ONE
   * OPEN PROPOSAL PER DECLARED KIND: three declared kinds means at most three
   * cards, ever, at once. That is structurally stronger than a rate limit,
   * which resets — to post a new card in a kind the plugin must first withdraw
   * the old one or the user must resolve it.
   *
   * `kinds[].label` is the USER-FACING name of the slot, so consent reads as
   * "this plugin may raise these two kinds of suggestion" rather than "this
   * plugin may post cards".
   *
   * A malformed block grants NOTHING rather than granting the entries that
   * happened to parse — a consent-bearing declaration has no partial form.
   */
  workProposals?: {
    /** Human-readable justification surfaced to the user. */
    reasoning?: string;
    /** 1..4 entries. Ids must be unique within the plugin. */
    kinds: WorkProposalKind[];
  };
  /**
   * Alert declaration — the kinds of alert this plugin may raise, each with
   * declared, localised templates and typed slots, plus the overlay sources
   * it may pass to {@link PluginHostApi.triggerConversation}.
   *
   * DECLARATION IS AUTHORIZATION, as for {@link PluginManifest.workProposals}:
   * a kind that is not declared is not granted, and a block that is malformed
   * in any entry grants nothing. A manifest that carries the block at all —
   * even a refused one — may trigger conversations only from the sources
   * listed in `suggestions`.
   */
  alerts?: PluginAlertsDeclaration;
  /** Reviewed filesystem reach for a confined plugin child. */
  sandbox?: PluginSandboxDeclaration;
  /**
   * Config keys this plugin fills from a retired predecessor's saved config,
   * once, when the retirement names this plugin as a successor. A target key
   * the user already set is never overwritten. Two entries with the same
   * `to` refuse the whole list.
   */
  configInherits?: ConfigInheritDeclaration[];
  dependencies?: Array<string | DependencySpec>;
  pluginAccess?: PluginAccessSpec;
  requires?: RequiresSpec;
  /**
   * npm package name persisted into installed manifests by the marketplace
   * service for rollback support. The publish pipeline owns this value;
   * plugin authors should not set it manually.
   */
  packageName?: string;
  /**
   * Optional hard startup timeout (ms, positive integer).
   * When declared, PluginRuntime enforces a `Promise.race`-based timeout on
   * the plugin's `start()` call — the running task is NOT cancelled
   * (no AbortController is wired through); the host simply drops the slow
   * plugin fail-soft while leaving other plugins untouched. When absent, the
   * runtime still emits a slow-plugin warning after a default threshold
   * (5000ms).
   */
  startupTimeoutMs?: number;

  /**
   * §9.2 — declarative settings schema. When present, the host
   * renders a typed configuration form in `PluginConfigTab` (string →
   * TextInput, number → NumberInput, boolean → Switch, enum → Select,
   * array of strings → TagInput, `format: "secret"` → masked SecretInput
   * that lands in the encrypted keychain — never in cleartext
   * `pluginConfigs`). Plugins without `configSchema` keep the legacy raw
   * key/value editor (back-compat).
   */
  configSchema?: PluginConfigSchema;
  /**
   * Optional Lucide icon name for the plugin grid UI. When present, the host
   * dynamically looks up the named icon from `lucide-react` and renders it as
   * a monochrome stroke icon in the plugin grid popover. Falls back to `Plug`
   * when omitted or when the name doesn't match any Lucide export.
   *
   * Example values: `"Mic"`, `"FileText"`, `"Share2"`.
   * Full list: https://lucide.dev/icons/
   */
  icon?: string;
  /**
   * Optional short text (1-4 chars) rendered in place of a Lucide icon — e.g.
   * `"AB"`, `"MTG"`. Takes precedence over `icon` when both are declared.
   * Use when no Lucide glyph matches the plugin's domain identity.
   */
  iconText?: string;
  /** Optional Python runtime co-deployment metadata. */
  python?: {
    /** `ave` (the host app) installs the declared lock; `self` leaves runtime ownership to the plugin. */
    managedBy?: "ave" | "self";
    /** Lockfile path relative to the verified plugin root. */
    requirementsLock?: string;
    /** Optional interpreter override for self-managed runtimes. */
    interpreter?: string;
  };
  /**
   * #893 — Declarative allowlist of host-owned secret keys this plugin is
   * allowed to read via `hostApi.getSecret(key)`. The runtime gate matches
   * the requested key against `hostSecrets.read[]` (`audit.log` on
   * allow + deny) and currently accepts entries shaped
   * `llm.apiKey.<vendor>` or
   * `llm.marketplaceProvider.<presetId>.apiKey` — enforced both here at
   * manifest load time and by the host-owned JSON schema, so plugins cannot
   * grant themselves wildcard access with an older vendored contract.
   *
   * Keys outside the namespace are rejected at manifest load
   * (`manifest_schema` reason) so a misconfigured plugin never reaches the
   * runtime gate. A plugin's own `plugin.<id>.*` namespace remains
   * always-allowed and does NOT need an entry here.
   */
  hostSecrets?: {
    /** Allowlisted secret keys this plugin can read via `hostApi.getSecret`. */
    read?: string[];
  };
  /** Marketplace-only advertisement of UI slot names; bindings remain in `ui[].slot`. */
  uiSlots?: string[];
}

/** A plugin whose process is the host's reference runtime importing this JS module. */
export interface EntryPluginManifest extends PluginManifestFields {
  entry: string;
  process?: never;
}

/** A plugin whose process is its own executable, speaking the protocol itself. */
export interface ProcessPluginManifest extends PluginManifestFields {
  process: PluginProcessEntry;
  entry?: never;
}

/**
 * A plugin manifest: exactly one of `entry` and `process`.
 *
 * A union rather than one interface with two optional fields, because that
 * interface — and the wire schema projected from it — would accept both and
 * neither (docs/design/plugin-hostapi-protocol.md decision 33).
 */
export type PluginManifest = EntryPluginManifest | ProcessPluginManifest;

/** Which of the two ways to produce the plugin's process a manifest declares. */
export function pluginEntryKind(manifest: PluginManifest): "entry" | "process" {
  return manifest.process !== undefined ? "process" : "entry";
}

export interface PluginFirstTaskCopy {
  headline: string;
  body: string;
  actionLabel: string;
  composerPrompt: string;
}

/** Per-locale display copy for one onboarding highlight. */
export interface PluginHighlightCopy {
  headline: string;
  body: string;
  actionLabel: string;
}

/**
 * What accepting a highlight does. Every arm is inert on its own: the host
 * performs the effect, and the two that do anything only move the user — text
 * into the visible composer, or the settings view onto a page and the section
 * within it. Nothing here runs a turn, calls a tool, or reaches the network.
 */
export type PluginOnboardingAction =
  /** Put `prompt` in the focused conversation's composer, unsent. */
  | { kind: "composer"; prompt: string }
  /**
   * Move the settings view to `path`: a settings tab id (`plugin-config`,
   * `llm`, …), optionally followed by `/` and one section within that tab
   * (`permissions/permissions-os-sandbox`). Naming the section lands the user
   * on the control the highlight is about instead of on the page that holds
   * it. The host validates both halves against the tabs and sections this
   * build actually ships and rejects the manifest otherwise, so a highlight
   * can never point at a destination that does not exist.
   */
  | { kind: "settings"; path: string }
  /** Say the thing and stop. The card is informational. */
  | { kind: "none" };

/**
 * One onboarding highlight or new-feature promotion.
 *
 * `id` is the plugin's own stable name for this proposal, and half of the key
 * the host remembers the user's answer under — renaming it asks the question
 * again.
 */
export interface PluginOnboardingHighlight {
  /** Stable kebab-case id, unique within the declaring plugin. */
  id: string;
  /** Lower numbers are proposed first; an omitted priority sorts last. */
  priority?: number;
  /** Normalized lower-case BCP-47 tags; English is the required fallback. */
  copy: Record<string, PluginHighlightCopy>;
  action: PluginOnboardingAction;
}

/**
 * How many highlights one plugin may declare.
 *
 * A nag budget rather than a storage limit: each highlight is a question the
 * user answers once, and a plugin free to declare twenty would spend the whole
 * first session on its own tour.
 */
export const MAX_PLUGIN_ONBOARDING_HIGHLIGHTS = 5;

export interface PluginOnboardingSpec {
  /**
   * The first thing to do after the tour. One per plugin, and proposed ahead
   * of that plugin's highlights.
   */
  firstTask?: {
    /** Lower numbers are proposed first. */
    priority: number;
    /** Normalized lower-case BCP-47 tags; English is the required fallback. */
    locales: Record<string, PluginFirstTaskCopy>;
  };
  /**
   * Capability highlights and new-feature promotions, at most
   * {@link MAX_PLUGIN_ONBOARDING_HIGHLIGHTS}.
   */
  highlights?: PluginOnboardingHighlight[];
}

/**
 * A contribution identity is local to its owning plugin and contribution kind.
 * `path` is always a normalized, plugin-root-relative POSIX path. Runtime code
 * must resolve it through the Host contribution resolver before reading bytes.
 */
export interface PluginContributionDeclaration {
  id: string;
  path: string;
}

export type PluginSandboxGrant =
  | { kind: "hostDirectory"; segments: ["runtime"] | ["certs"]; why: string }
  | { kind: "userChosenDirectory"; configKey: string; why: string };

export interface PluginSandboxDeclaration {
  read?: PluginSandboxGrant[];
  write?: Extract<PluginSandboxGrant, { kind: "userChosenDirectory" }>[];
}

/**
 * §9.2 — declarative settings schema. JSON Schema draft-07 subset
 * (the same dialect a tool's `inputSchema` uses) with one UI/storage hint:
 * `format: "secret"` routes the field through
 * `hostApi.setSecret` / `getSecret` so the cleartext `pluginConfigs`
 * record never sees the value.
 */
export interface PluginConfigSchema {
  /** Optional `$schema` identifier; informational only. @optional */
  $schema?: string;
  /** Property declarations keyed by config key. */
  properties: Record<string, PluginConfigSchemaProperty>;
  /** Property keys that must have a value after merging defaults + saved values. @optional */
  required?: string[];
  /**
   * Optional escape hatch — when declared, the host renders a custom React
   * panel underneath the auto-generated form. `entry` is a path relative
   * to the plugin root; `exportName` is the named export to mount. The
   * panel runs inside the same UI Slot System as `manifest.ui[]` (§9.3).
   * Use sparingly — schema fields cover the common case.
   * @optional
   */
  customPanel?: { entry: string; exportName: string };
}

/** One language's overrides for a {@link PluginConfigSchemaProperty}'s text. At least one field. */
export interface PluginConfigSchemaPropertyLocalizedText {
  /** @optional */
  title?: string;
  /** @optional */
  description?: string;
}

/** Schema for a single configuration property. */
export interface PluginConfigSchemaProperty {
  /** JSON Schema-compatible value type. */
  type: "string" | "number" | "integer" | "boolean" | "array";
  /** Short human-readable label. @optional */
  title?: string;
  /** Long-form description rendered as helper text. @optional */
  description?: string;
  /**
   * Per-language overrides of `title` / `description`, keyed by a normalized
   * lower-case BCP-47 tag; resolved like {@link PluginUiExtension.locales}
   * (exact tag → base language → own field → the config key).
   * @optional
   */
  locales?: Record<string, PluginConfigSchemaPropertyLocalizedText>;
  /** Default value used when the saved config has no entry for this key. @optional */
  default?: unknown;
  /** Closed list of allowed values; renders a select. @optional */
  enum?: Array<string | number | boolean>;
  /** Minimum value (`number` / `integer`). @optional */
  minimum?: number;
  /** Maximum value (`number` / `integer`). @optional */
  maximum?: number;
  /** Minimum string length (`string`). @optional */
  minLength?: number;
  /** Maximum string length (`string`). @optional */
  maxLength?: number;
  /** Regex pattern (`string`). @optional */
  pattern?: string;
  /**
   * UI/storage hint:
   * - `"secret"` → masked input; saved via `hostApi.setSecret(plugin.<id>.<key>)`
   *   into the host-encrypted `ave-secrets.json`. Never written to
   *   cleartext `settings.pluginConfigs`. Plugins read via `hostApi.getSecret`.
   * - other formats are advisory and rendered as plain inputs today.
   * @optional
   */
  format?: "secret" | "uri" | "email" | "date-time";
  /** Item schema when `type === "array"`. Only string-item arrays are auto-rendered as a tag input. @optional */
  items?: { type: "string" | "number" | "integer" | "boolean"; enum?: Array<string | number | boolean>;
  };
}

/** One language's overrides for a {@link PluginUiExtension}'s text. At least one field. */
export interface PluginUiExtensionLocalizedText {
  /** @optional */
  displayName?: string;
  /** @optional */
  title?: string;
  /** @optional */
  description?: string;
}

export interface PluginUiExtension {
  id: string;
  /**
   * Where the surface renders.
   *
   * `"sidebar"` is a panel inside the app window. `"floating"` is a slot in
   * the host's floating dock — one host-owned always-on-top window, framed by
   * host chrome, that a plugin attaches into with `hostApi.attachFloatingPanel`.
   * Declaring `"floating"` does not open anything; it only makes the surface
   * eligible to be attached.
   */
  slot: "sidebar" | "floating";
  /**
   * Panel surface kind. The `"action"` kind (an icon that dispatched a declared
   * tool with no panel) was removed in #885 v6 along with its `tool` field —
   * app-invokable behavior is now expressed by a tool's `_meta.ui.visibility`.
   */
  kind: "embedded-module" | "embedded-page" | "info-card";
  /** Short label for menus and the sidebar. Falls back to `title`. */
  displayName?: string;
  title: string;
  description?: string;
  /**
   * Per-language overrides of `displayName` / `title` / `description`, keyed
   * by a normalized lower-case BCP-47 tag (`en`, `ko`, `pt-br`). The host
   * resolves against its UI language: the exact tag, then its base language,
   * then this entry's own fields, then the plugin id. Requires Ave 0.14.1 or
   * later: earlier hosts reject the key, so a plugin declaring it (or the
   * `locales` of a `configSchema` property or of `auth`) sets
   * `requires.minAppVersion` to `"0.14.1"` or later.
   * @optional
   */
  locales?: Record<string, PluginUiExtensionLocalizedText>;
  defaults?: Record<string, unknown>;
  entry?: string;
  exportName?: string;
  page?: string;
}

/**
 * Signature envelope sidecar served by `/api/v1/plugins/{slug}/download.sig`.
 * Matches the server's §0.1 dual-sign format.
 */
export interface SignatureEnvelope {
  version: 1;
  /** Unix seconds. Used for clock-skew guard + revocation. */
  iat: number;
  /** Hex-encoded SHA-256 of the tarball bytes. */
  artifact_sha256: string;
  signatures: Array<{
    key_id: string;
    alg: "ed25519";
    /** Base64-encoded raw 64-byte signature. */
    sig: string;
  }>;
}

/** Result of verifying a {@link SignatureEnvelope} against a tarball. */
export interface VerifyResult {
  ok: boolean;
  key_id?: string;
  reason?: string;
}

/**
 * Dependency specification extracted from plugin manifest's `requires` block.
 * Capabilities are kebab-case tags matching `^[a-z][a-z0-9-]*$`.
 *
 * Keep this host-owned interface consistent with the manifest JSON schema
 * (`schemas/plugin-manifest.schema.json`). Plugins vendor both files together.
 */
export interface RequiresSpec {
  /** Dependency capabilities required from installed plugins. @optional */
  capabilities?: string[];
  /**
   * Minimum compatible Ave app version — a plain SemVer `MAJOR.MINOR.PATCH`
   * string (NOT a range; Obsidian-style). Absent = compatible with all
   * versions (purely additive, backward-compatible).
   *
   * The host hard-blocks at BOTH boundaries when the running app version is
   * lower than this:
   *   - INSTALL (marketplace): throws {@link IncompatibleAppVersionError}
   *     before the artifact is downloaded.
   *   - LOAD (runtime): skips `start()` and surfaces a non-dismissable
   *     "needs newer app" state (e.g. after the user downgraded the app or
   *     sideloaded an artifact built for a newer host).
   */
  minAppVersion?: string;
  /**
   * The Ave host protocol version the plugin speaks — an integer written as a
   * string (`"3"`). A missing declaration or a version the running app does not serve refuses the load with
   * `incompatible-host-protocol`. An older app whose schema lacks the field
   * rejects the manifest outright, so a plugin that declares it also sets
   * `minAppVersion` to the first release that knows it. @optional
   */
  hostProtocol?: string;
}

/**
 * Thrown by marketplace install preflight when required capabilities
 * are not satisfied by currently-installed plugins.
 */
export class MissingDependenciesError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Plugin requires capabilities not provided by installed plugins: ${missing.join(", ")}`,
    );
    this.missing = missing;
    this.name = "MissingDependenciesError";
  }
}

/**
 * Thrown by marketplace install preflight when the plugin declares
 * `requires.minAppVersion` higher than the running Ave app version. This is a
 * HARD BLOCK raised BEFORE the artifact is downloaded — the user must update
 * the app before the plugin can be installed.
 *
 * `required` / `current` are plain SemVer strings. The IPC layer maps this to
 * the English error code `incompatible-app-version`; the renderer maps that
 * code to the Korean copy (per the IPC Error Message Language Convention).
 */
export class IncompatibleAppVersionError extends Error {
  readonly required: string;
  readonly current: string;
  constructor(required: string, current: string) {
    super(`plugin requires Ave >= ${required}, current ${current}`);
    this.required = required;
    this.current = current;
    this.name = "IncompatibleAppVersionError";
  }
}

/** Stable English IPC error code for {@link IncompatibleAppVersionError}. */
export const INCOMPATIBLE_APP_VERSION_CODE = "incompatible-app-version";

/**
 * Thrown by marketplace install preflight when a plugin declares
 * `dependencies[].required = true` and the referenced plugin id is not
 * present in the installed registry. `required: false` entries are
 * informational — the host does NOT auto-install dependencies (issue #92),
 * the consumer plugin must degrade its feature surface when a soft
 * dependency is absent.
 */
export class MissingPluginDependenciesError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Plugin requires the following plugins to be installed first: ${missing.join(", ")}`,
    );
    this.missing = missing;
    this.name = "MissingPluginDependenciesError";
  }
}

/**
 * Mirror of the `runtime` block from `mcp.schema.json` (ave-marketplace#52).
 * Two transport branches; tokens in `args` (`$PLUGIN_DIR`, `$PYTHON`, `$NODE`)
 * are substituted by the host at install time.
 */
export type McpRuntimeSpec =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      auth?: "none" | "api-key" | "sso";
      /** Safe env var name that receives the user-supplied apiKey at launch. */
      apiKeyEnv?: string;
    }
  | {
      transport: "http";
      url: string;
      auth?: "none" | "api-key" | "sso" | "oauth";
      /** Safe header name that receives the user-supplied apiKey on requests. */
      apiKeyHeader?: string;
      allowPrivateNetworks?: boolean;
      oauth?: McpOAuthMetadata;
    };

export interface McpOAuthMetadata {
  /** RFC 8707 resource identifier for the target MCP server. */
  resource?: string;
  /** RFC 9728 protected resource metadata URL, when advertised by the server/catalog. */
  resourceMetadataUrl?: string;
  /** Authorization server issuers discovered from protected resource metadata. */
  authorizationServers?: string[];
  /** Initial least-privilege scopes requested for this MCP server. */
  scopes?: string[];
  clientRegistration?:
    | "client-id-metadata-document"
    | "dynamic"
    | "preregistration"
    | "manual";
  /**
   * Optional public OAuth client ID that the authorization server pre-registered
   * for this MCP server. Ave uses it before a Client ID Metadata Document or
   * dynamic registration, with PKCE and no client secret. The registration must
   * allow the loopback redirect `http://127.0.0.1` on any port (RFC 8252 §7.3).
   * 1–256 visible ASCII characters; anything else makes authentication fail
   * with an unsupported-registration error. Omit it to keep the previous behavior.
   */
  clientId?: string;
}

export interface McpAuthMetadata extends McpOAuthMetadata {
  mode: "none" | "api-key" | "sso" | "oauth";
  transport?: "stdio" | "http";
}

/**
 * Error thrown by every `PluginStorage` method when a path violates the
 * sandbox rules: absolute paths, lexical `..` escapes, and symlinks whose
 * realpath escapes the plugin's storage root (including dangling symlinks whose
 * target cannot be verified). Plugin authors writing TypeScript can branch on this
 * class via `instanceof`:
 *
 * ```ts
 * try {
 *   await ctx.hostApi.storage.write(rel, data);
 * } catch (err) {
 *   if (err instanceof PluginStorageError) {
 *     // err.pluginId, err.attemptedPath available for diagnostics
 *   }
 * }
 * ```
 *
 * `name` is always `"PluginStorageError"` for plugins that prefer string
 * matching across realm boundaries.
 */
export class PluginStorageError extends Error {
  readonly pluginId: string;
  readonly attemptedPath: string;
  constructor(message: string, pluginId: string, attemptedPath: string) {
    super(`[plugin-storage:${pluginId}] ${message}: ${attemptedPath}`);
    this.name = "PluginStorageError";
    this.pluginId = pluginId;
    this.attemptedPath = attemptedPath;
  }
}

/**
 * Thrown by {@link PluginStorage.writeEncrypted} / {@link PluginStorage.readEncrypted}
 * when the host encryption provider is unavailable. Desktop hosts use OS
 * encryption; native hosts can use an explicitly configured external key.
 *
 * FAIL-CLOSED, No-Fallback: the encrypted variants NEVER read or write plaintext
 * when encryption is unavailable. A dynamically-acquired secret must not silently
 * land on disk unprotected, so the call throws instead of degrading. Plugin
 * authors can branch on this class via `instanceof`; `name` is always
 * `"PluginStorageEncryptionUnavailableError"` and `code` is the stable
 * kebab-case `"encryption-unavailable"` for callers that prefer string matching
 * across realm boundaries.
 */
export class PluginStorageEncryptionUnavailableError extends Error {
  readonly code = "encryption-unavailable";
  readonly pluginId: string;
  constructor(pluginId: string) {
    super(
      `[plugin-storage:${pluginId}] Host encryption is unavailable; encrypted storage cannot be used (no plaintext fallback)`,
    );
    this.name = "PluginStorageEncryptionUnavailableError";
    this.pluginId = pluginId;
  }
}

/**
 * Supported text encodings for PluginStorage read/write operations.
 * Defined explicitly to avoid leaking @types/node into the public contract.
 */
export type StorageEncoding =
  | "utf-8"
  | "utf8"
  | "ascii"
  | "base64"
  | "base64url"
  | "hex"
  | "latin1"
  | "binary";

/**
 * Sandboxed storage rooted at the plugin's host-only storage directory,
 * `<pluginsRoot>/<pluginId>/storage/` — beside `pluginDataDir`, NOT inside it.
 * The host reads and writes it on the plugin's behalf and no confined plugin
 * process can write it, so files stored here are reached through this API, not
 * through `node:fs` under `pluginDataDir`. All paths are resolved relative to
 * that root. Path traversal via `..`, absolute paths, and symlinks
 * escaping the root via realpath checks are rejected with `PluginStorageError`
 * (exported from this module — plugin authors can `instanceof`-check it).
 *
 * The realpath check walks up from the resolved target until it finds an
 * existing entry, then verifies that entry's canonical path stays inside the
 * root — this catches both "reads through a symlink that points outside" and
 * "writes whose closest existing ancestor is a symlink that points outside".
 * Dangling symlinks (probe lstat = symlink, realpath ENOENT) are rejected
 * conservatively because the host cannot validate where they would resolve to.
 *
 * Plugins should prefer this over `node:fs` so the host can audit / sandbox /
 * restrict writes uniformly. Every operation throws if the resolved path
 * escapes the storage root.
 */
export interface PluginStorage {
  /**
   * Resolve `segments` to an absolute path inside the plugin's storage root.
   * Throws if the resolved path escapes the root. The path names where the
   * host keeps the entry; the plugin process can read it there only where its
   * sandbox allows, and can never write it.
   */
  resolve(...segments: string[]): string;
  /** Read raw bytes; throws ENOENT if the file does not exist. */
  read(relPath: string): Promise<Uint8Array>;
  /** Read text; throws ENOENT if the file does not exist. */
  readText(relPath: string, encoding?: StorageEncoding): Promise<string>;
  /** Read + parse JSON; returns `null` on missing file, throws on bad JSON. */
  readJson<T = unknown>(relPath: string): Promise<T | null>;
  /** Write bytes / text; ensures parent directories exist. */
  write(
    relPath: string,
    data: string | Uint8Array,
    encoding?: StorageEncoding,
  ): Promise<void>;
  /** Stringify + write JSON; ensures parent directories exist. */
  writeJson<T>(relPath: string, value: T, indent?: number): Promise<void>;
  /** Remove a file or directory tree; missing paths are ignored. */
  rm(relPath: string, options?: { recursive?: boolean }): Promise<void>;
  /** List entries in `relPath` (directories included). Empty for missing dir. */
  list(relPath?: string): Promise<string[]>;
  /** Test whether the path exists. */
  exists(relPath: string): Promise<boolean>;
  /** Ensure a directory exists (recursive mkdir). */
  mkdir(relPath: string): Promise<void>;
  /**
   * Encrypt `plaintext` with the host's configured encryption provider and
   * write the ciphertext bytes to `relPath`, inside the same sandboxed
   * storage root as every other method — identical absolute-path /
   * lexical `..` / symlink-escape rejection applies. Parent directories are
   * created as needed.
   *
   * Intended for DYNAMICALLY-ACQUIRED secrets/tokens a plugin obtains at runtime
   * (OAuth/MSAL token caches, harvested session material) — this is the plugin's
   * own encrypted-at-rest store. Contrast with {@link PluginHostApi.getSecret},
   * which reads HOST-PROVISIONED config secrets declared in the manifest.
   *
   * FAIL-CLOSED: if host encryption is unavailable this throws
   * {@link PluginStorageEncryptionUnavailableError} and writes NOTHING — the
   * plaintext is never persisted unprotected (No-Fallback rule).
   */
  writeEncrypted(relPath: string, plaintext: string): Promise<void>;
  /**
   * Read the ciphertext previously written by {@link writeEncrypted} at `relPath`
   * and return the decrypted UTF-8 plaintext. Throws ENOENT if the file does not
   * exist (same contract as {@link readText}); throws
   * {@link PluginStorageEncryptionUnavailableError} if host encryption is
   * unavailable — it never returns raw ciphertext or a plaintext guess.
   */
  readEncrypted(relPath: string): Promise<string>;
}

/**
 * Discriminated event delivered to `PluginHostApi.onPluginsChanged` handlers.
 * `source: "local-dev"` indicates the install came from the dev-mode
 * "Settings → 로컬 폴더에서 설치" path (AVE_DEV=1 only); production
 * consumers should ignore it.
 *
 * The `_future` sentinel variant is NEVER produced at runtime — it exists
 * purely to force exhaustive `switch (event.type)` consumers to add a
 * `default:` branch, so the host can add a new variant (e.g. `"updated"`
 * for version bumps) without silently breaking subscribers. Plugins that
 * narrow with `if (event.type === "installed") ... else if (...)` pick up
 * the same forward-compat for free.
 */
export type PluginLifecycleEvent =
  | { type: "installed"; pluginId: string; source: "marketplace" | "local-dev" }
  | { type: "uninstalled"; pluginId: string }
  | { type: "_future"; readonly __exhaustive: never };

/**
 * The spec a plugin hands `PluginHostApi.spawnWorker`. `pluginId` is NOT part of
 * the spec — the host binds it from the calling hostApi instance, so a plugin
 * cannot spawn a worker under another plugin's namespace. (The host-internal
 * primitive in `src/permissions/worker-spawn.ts` accepts the same shape plus
 * the bound `pluginId`.)
 *
 * The worker's stdin is the host's liveness pipe: it carries no bytes and
 * closes only when the host process is gone. A long-lived worker MUST treat
 * EOF on stdin as "exit now" — it is the one signal that survives a host crash
 * or kill, which the host's shutdown sweep never sees. A short-lived command
 * may ignore it.
 */
export interface PluginWorkerSpec {
  /**
   * Stable per-worker id — names the control dir + reviewer registry key.
   * Must match `[a-z0-9][a-z0-9._-]{0,127}`; uppercase and other invalid
   * ids fail closed so case-insensitive filesystems cannot alias workers.
   */
  readonly workerId: string;
  /** The worker executable to spawn (absolute path or PATH-resolved name). */
  readonly command: string;
  /** Argv for the worker. The UDS path is injected per `udsArgName`. */
  readonly args?: readonly string[];
  /** Extra env merged onto the host's secret-stripped base env. */
  readonly env?: Record<string, string | undefined>;
  /**
   * Paths the worker may read in addition to write-granted paths. Trusted
   * plugin code should declare runtime/script/CA inputs here; the host does
   * not infer filesystem grants from argv.
   */
  readonly allowReadPaths?: readonly string[];
  /** Paths the worker may write. The host-allocated control-socket dir is
   *  unioned on automatically. */
  readonly allowWritePaths?: readonly string[];
  /**
   * How the host tells the worker WHERE to bind the control socket (only when
   * the returned `socketPath` is non-null):
   *   - a string like `"--uds"` → appends `[udsArgName, socketPath]` to args;
   *   - `{ env: "AVE_CONTROL_SOCKET" }` → sets that env var to socketPath.
   * Omitted ⇒ the worker is not told the path through this primitive.
   */
  readonly udsArgName?: string | { readonly env: string };
}

/**
 * The handle `PluginHostApi.spawnWorker` resolves to. `socketPath` is the
 * host-side UDS path to connect to, or `null` when the worker should use TCP
 * control. `null` covers gate-OFF plain spawn and Windows ASRT-wrapped workers
 * (Windows keeps TCP control while filesystem/network effects are confined).
 * Callers must not infer sandbox status from transport alone. `stop()` is the
 * host's orderly path; the worker's stdin (see {@link PluginWorkerSpec}) is the
 * one that outlives the host.
 */
export interface SpawnedPluginWorker {
  readonly socketPath: string | null;
  readonly pid: number | undefined;
  /** Stop the worker (SIGTERM → SIGKILL grace) + release ASRT/UDS state. */
  stop(): void;
  /** Subscribe to worker stdout (utf-8 chunks). */
  onStdout(listener: (chunk: string) => void): void;
  /** Subscribe to worker stderr (utf-8 chunks). */
  onStderr(listener: (chunk: string) => void): void;
  /**
   * Subscribe to worker EXIT (crash or normal). Fires once when the worker
   * process exits. The handle owns lifecycle, so a consumer MUST use this to
   * detect a crashed worker (mark it dead / restart) — without it `isRunning`
   * style state can never go false after a crash.
   */
  onExit(
    listener: (info: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void,
  ): void;
}

/**
 * Host API — 플러그인이 호스트 서비스에 접근하는 인터페이스.
 * 플러그인 제거 시 해당 플러그인이 등록한 모든 것이 자동 정리된다.
 */
export interface ResolveApiKeyOptions {
  purpose: "llm" | "stt" | "embedding" | "vision";
  vendor?: "openai" | "azure-openai" | "vertex" | "anthropic";
  exposure?: "lease" | "raw";
  signal?: AbortSignal;
}

export interface ApiKeyLease {
  readonly exposure: "lease";
  readonly leaseId: string;
  readonly vendor: string;
  readonly baseUrl?: string;
  release(): Promise<void>;
  onClosed(listener: (reason: "revoked" | "peer-gone") => void): () => void;
}

export interface ApiKeyRaw {
  readonly exposure: "raw";
  readonly vendor: string;
  readonly baseUrl?: string;
  readonly key: string;
  release(): Promise<void>;
}

export type ResolveApiKeyDenied = {
  ok: false;
  reason: "no-host-vendor" | "vendor-mismatch" | "not-whitelisted"
    | "user-mode-plugin" | "aborted" | "user-endpoint-with-host-key"
    | "raw-exposure-denied" | "audience-not-allowlisted" | "vendor-unsupported"
    | "endpoint-unavailable" | "stale-authorization" | "lease-limit";
};

export type ResolveApiKeyResult =
  | ({ ok: true } & ApiKeyLease)
  | ({ ok: true } & ApiKeyRaw)
  | ResolveApiKeyDenied;

export interface HostFetchInit extends RequestInit {
  auth?: { lease: string };
}

export interface PluginHostApi {
  /**
   * Sandboxed filesystem API scoped to this plugin's host-only storage
   * directory (beside `pluginDataDir`; see {@link PluginStorage}). Plugins
   * SHOULD prefer this over `node:fs` so the host can audit/restrict writes
   * uniformly. Direct `node:fs` use is still possible but bypasses sandbox
   * protections and is subject to future deprecation.
   */
  storage: PluginStorage;
  /**
   * §9.2 — typed access to this plugin's saved config. Reads return
   * the merged `manifest.config` defaults + saved overrides, scoped strictly
   * to the calling plugin's id (plugin A cannot read plugin B's config).
   * Writes persist via the same `setPluginConfig` IPC bridge used by the
   * settings UI and trigger a plugin reload so handlers see the new values
   * on next tool call. `format: "secret"` schema entries are rejected from
   * `set()` — secrets MUST go through `hostApi.setSecret` so they land in
   * the encrypted keychain, never in cleartext `pluginConfigs`.
   */
  config: {
    /** Read a single config key. Returns `undefined` when unset. */
    get<T = unknown>(key: string): T | undefined;
    /**
     * Persist a config key. Triggers a plugin reload so the new value is
     * visible to the plugin on next handler invocation.
     */
    set<T = unknown>(key: string, value: T): Promise<void>;
    /**
     * Subscribe to changes for a single key. Returns an `unsubscribe()`
     * disposer. The subscription is scoped to the caller's pluginId — a
     * change in plugin A cannot fire plugin B's listener.
     */
    onChange<T = unknown>(
      key: string,
      callback: (value: T | undefined) => void,
    ): () => void;
  };
  emitEvent(eventType: string, data?: unknown): void;
  /**
   * Subscribes to a host event. Returns an `unsubscribe()` disposer so callers
   * (and PluginRuntime.onDisable) can clean up handlers deterministically.
   */
  onEvent(eventType: string, handler: (data: unknown) => void): () => void;
  /**
   * Snapshot of plugin IDs currently loaded into the runtime, in load order.
   * The calling plugin's own id is excluded. Order is insertion-stable but
   * MUST NOT be treated as priority — use `.includes(id)` for membership
   * checks. Pair with `onPluginsChanged` to react to plugin lifecycle (e.g.
   * overlay-trigger detectors that depend on a specific plugin being installed).
   */
  getInstalledPluginIds(): string[];
  /**
   * Subscribe to plugin install / uninstall events. Returns an `unsubscribe()`
   * disposer (also cleared automatically on plugin disable).
   *
   * Fires AFTER the host has finished mounting (install) or unmounting
   * (uninstall) the plugin — `getInstalledPluginIds()` already reflects the
   * new state when the handler runs. Self-events (this plugin being the
   * subject) are filtered out.
   *
   * P0 only delivers `installed` / `uninstalled`. Future versions may add
   * `updated` (version bump) — handlers should branch with a `default:` to
   * stay forward-compatible.
   *
   * `source` distinguishes marketplace install from local-dev install
   * (AVE_DEV=1 + Settings → 로컬 폴더에서 설치). Production consumers
   * SHOULD ignore `source: "local-dev"` events to avoid letting a local
   * test plugin trigger downstream cascades against marketplace expectations.
   */
  onPluginsChanged(handler: (event: PluginLifecycleEvent) => void): () => void;
  /**
   * Read an allow-listed secret.
   *
   * Async because a plugin will run in its own process, and a synchronous
   * answer cannot cross one: `SharedArrayBuffer` + `Atomics.wait` shares memory
   * between THREADS, not processes, and pushing a snapshot into the child would
   * hand it the secrets up front — the opposite of what the gate is for. The
   * host implementation stays synchronous internally; it is the SIGNATURE that
   * has to survive the boundary.
   */
  getSecret(key: string): Promise<string | null>;

  /**
   * Host-managed LLM key resolver. Optional on older app releases; plugins
   * guard with `typeof hostApi.resolveApiKey === "function"` unless their
   * `requires.minAppVersion` guarantees a supporting release.
   *
   * Implementation in `src/main/host-api/resolve-api-key.ts` runs the four-tier
   * gate and returns the `ResolveApiKeyResult` discriminated union. Callers
   * receive the same `ok: true | false` discriminator across supported releases.
   */
  resolveApiKey?(opts: ResolveApiKeyOptions): Promise<ResolveApiKeyResult>;

  // ─── LLM 접근 (선제성 기능용) ────────────────────────────────────────
  /**
   * 호스트 LLM 프로바이더를 통한 텍스트 생성.
   * 플러그인이 직접 LLM 키를 관리하지 않고도 인텔리전트 기능 구현 가능.
   * LLM이 준비되지 않은 경우 에러를 던진다.
   */
  callLlm(
    prompt: string,
    options?: {
      maxTokens?: number;
      systemPrompt?: string;
      signal?: AbortSignal;
    },
  ): Promise<string>;
  /**
   * Host-mediated outbound HTTPS through Electron's `net` (Chromium network
   * stack). Unlike a plugin's own Node `fetch`/undici, this honors the OS proxy
   * resolution INCLUDING PAC/WPAD auto-config and the OS trust store on every
   * platform — so a plugin whose Node libraries can't be configured for the
   * corporate proxy/CA (e.g. MSAL) can still reach the network on a
   * TLS-inspecting corporate network. Capability-gated (external-auth-consumer)
   * + SSRF-validated + audited host-side.
   *
   * OPTIONAL: undefined on host builds that predate this capability. Plugins
   * that require host-mediated egress MUST guard
   * (`typeof hostApi.hostFetch === "function"`) and fail closed when absent;
   * do not replace this chokepoint with bare plugin fetch.
   */
  hostFetch?(input: string | URL, init?: HostFetchInit): Promise<Response>;

  /**
   * Structured log event routed through AuditLogger.
   * Automatically tagged with `plugin:${pluginId}` context (sessionId = "plugin").
   */
  logEvent(
    level: "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ): void;

  /**
   * Register a handler fired before app shutdown (Electron
   * `before-quit`). Host enforces a 5s timeout on each handler; slow handlers
   * are logged but do not block quit.
   */
  onShutdown(handler: () => void | Promise<void>): void;

  /**
   * Spawn a long-lived plugin worker, host-mediated and (when the OS-tool ASRT
   * sandbox gate is ON) ASRT-wrapped. macOS/Linux workers use a bind-mounted
   * Unix-domain-socket (UDS) control channel; Windows workers keep TCP control
   * but run under srt-win with a worker-lifetime holder PID ACL grant.
   *
   * `pluginId` is bound by the host from THIS hostApi instance — a plugin
   * cannot spawn a worker under another plugin's namespace. The worker's
   * control dir lives under the plugin's own `~/.ave/plugins/<pluginId>/run/
   * <workerId>/` (host-allocated, 0o700; socket 0o600).
   *
   * Returns a handle whose `socketPath` is the host-side path to connect to
   * (undici `Agent({ connect: { socketPath } })` / `http.request({ socketPath })`)
   * on the wrapped macOS/Linux UDS path. It is `null` for gate-OFF plain TCP and
   * for the Windows ASRT path, where the worker keeps TCP control while
   * filesystem/network effects are confined by the srt-win holder grant.
   *
   * OPTIONAL: undefined on host builds that predate this primitive — guard with
   * `typeof hostApi.spawnWorker === "function"`, mirroring `resolveApiKey?`.
   */
  spawnWorker?(spec: PluginWorkerSpec): Promise<SpawnedPluginWorker>;
  // ─── 외부 포털 interactive 인증 (쿠키 수집) ──────────────────────────
  /**
   * Electron BrowserWindow로 외부 포털 로그인 페이지를 띄우고,
   * 사용자가 직접 로그인 완료한 시점(`completionUrlPatterns` 매칭)의 쿠키를 수집.
   *
   * Selenium/webdriver 없이 Electron 내장 Chromium을 사용한다.
   * 반환된 쿠키는 플러그인이 직접 HTTP 요청에 싣는다 — 호스트가 세션을 보관하지 않는다.
   *
   * **완료 URL 매칭 규칙:** 호스트는 현재 URL 의 `origin + pathname` 에 대해서만
   * `completionUrlPatterns` substring 매칭을 수행한다. query / hash 는 제외되므로
   * IdP 가 `RelayState=.../portal.example.com/` 같은 파라미터로 목적지를 담아 와도
   * IdP 도메인에 있는 동안에는 "완료" 로 오인하지 않는다.
   *
   * **Capability gate:** `manifest.capabilities[]` 에 `external-auth-consumer`
   * 선언 필수.
   *
   * **Session partition:** `persistPartition` 미지정 시 호스트가 plugin 별
   * 비영속 partition (`plugin-auth:${encodeURIComponent(pluginId)}`) 을 주입한다.
   * 플러그인이 영속 partition 을 요청하려면 자기 네임스페이스 안에서만 가능 —
   * `persist:plugin-auth:${encodeURIComponent(pluginId)}` 또는 그 하위 suffix
   * (`persist:plugin-auth:${encodeURIComponent(pluginId)}:<sub>`) 만 허용된다.
   * 다른 값은 runtime 에서 거부된다 (cross-plugin 쿠키 탈취 방지).
   *
   * §6.1 "3+ 플러그인 규칙" 예외 #2 (보안·감사 통제 필요)로 정당화 — 외부 포털 쿠키
   * 수집은 민감 자산 취급이므로 단일 플러그인 사용처여도 HostApi에서 제공한다.
   */
  openAuthWindow(
    options: OpenAuthWindowWithFinalUrlOptions,
  ): Promise<OpenAuthWindowFinalUrlResult>;
  openAuthWindow(
    options: OpenAuthWindowCookieOptions,
  ): Promise<AuthWindowCookie[]>;

  /**
   * A host-owned loopback listener that catches ONE OAuth authorization-code
   * redirect.
   *
   * WHY IT EXISTS. The authorization-code flow needs something listening at the
   * redirect URI. A plugin loaded in-process opened that socket itself; a
   * plugin loaded in a confined child cannot — on macOS the bind is refused
   * outright, and on Linux it SUCCEEDS into a private loopback the user's
   * browser is not in, so the sign-in hangs after the password has already been
   * typed. Moving the listener to the host is what makes the flow survive the
   * process boundary; see `plugin-process-isolation.md` Stage 8.
   *
   * WHAT THE PLUGIN CONTROLS: when to open, when to stop waiting, when to
   * close. Nothing else. It does not choose the interface, the port, the
   * accepted method, or the response body, and it receives the redirect's QUERY
   * PARAMETERS alone — no headers, no path, no body. The response page is the
   * host's on purpose: a plugin-supplied template would be plugin markup
   * rendered by the user's browser on a loopback origin.
   *
   * CROSS-PLUGIN: the handle is bound to the calling plugin, and one catcher
   * may be open per plugin at a time. A handle belonging to another plugin is
   * reported as unknown rather than as forbidden, so a plugin cannot use these
   * members to detect that another plugin has a sign-in in flight.
   *
   * SECURITY. Use the returned state unchanged together with PKCE S256; state
   * does not replace PKCE. See RFC 9700 sections 2.1.1 and 4.8.
   *
   * SHAPE. Three members rather than one because the caller needs the redirect
   * URI BEFORE the browser opens and the parameters AFTER it returns, and
   * because a flow that fails in between still has to release the port. This is
   * also the shape `@azure/msal-node`'s `ILoopbackClient` asks for, which is
   * not a coincidence — it is the same flow.
   */
  authRedirect: {
    /** Bind the listener and mint state. Rejects when this plugin already has one open. */
    open(): Promise<AuthRedirectOpenResult>;
    /**
     * Resolve only with an exact-path callback carrying the host-issued state.
     * A provider refusal is returned in `error` / `error_description`; check it
     * before exchanging a code. Invalid state does not consume the waiter.
     * Rejects on timeout or close; caches the first validated callback.
     */
    wait(options: { handle: string; timeoutMs?: number }): Promise<AuthRedirectParams>;
    /** Release the listener. Idempotent. */
    close(options: { handle: string }): Promise<void>;
  };

  /**
   * Ask the user which folders the plugin should work on.
   *
   * AN ANSWER, NOT A GRANT. A confined plugin child's read confinement is
   * deny-only, so an ordinary user directory was already readable; what the
   * plugin could not do is find out WHICH one the user meant. Nothing here
   * widens the child's envelope — writing to a picked path is still refused
   * unless a reviewed `userChosenDirectory` row already granted it.
   *
   * WHY THE HOST OWNS IT. `dialog` is an Electron main API. A plugin that
   * resolves `electron` to reach one method holds main's whole surface, which
   * is what keeps it from being routed out-of-process at all.
   *
   * A CANCEL IS AN ANSWER. `canceled` is true when the user dismissed the
   * chooser or selected nothing; it is not an error, and the two are not worth
   * distinguishing because both mean the user named no folder.
   *
   * ATTRIBUTION: the chooser's title names the calling plugin, decided by the
   * host from the HostApi instance rather than supplied by the caller.
   *
   * Rejects when this plugin already has a chooser open — a modal the user must
   * dismiss is a claim on their attention, and stacking them is refused rather
   * than queued.
   */
  pickFolders(): Promise<{ canceled: boolean; folders: string[] }>;

  /**
   * The UNC path behind a Windows mapped drive (`"Z:"` → `"\\\\server\\share"`),
   * or `null` when the drive has no UNC backing.
   *
   * WHY THE HOST OWNS IT. Windows exposes no binding for this, so answering it
   * means running `powershell.exe`. Spawning an interpreter is ambient axis 3 in
   * the routing SOT — the axis confinement exists to take away — and the answer
   * is one string. The caller supplies a DRIVE LETTER and the host supplies the
   * command, so nothing a plugin passes reaches a shell.
   *
   * `null` MEANS AN ORDINARY LOCAL DISK, and is a complete answer. It never
   * means the lookup failed: that REJECTS. A caller building an allow-list has
   * to tell those apart, because a drive it could not resolve leaves a root
   * missing with nothing to report.
   *
   * Every non-Windows platform answers `null` — a mapped drive is not a thing
   * there.
   */
  resolveMappedDriveRoot(drive: string): Promise<string | null>;
  /**
   * Microphones the user could pick. Labels are empty until microphone access
   * has been granted at least once — the browser's rule, not this host's, and
   * an empty label means "not yet permitted", never "no device".
   */
  listAudioInputDevices(): Promise<readonly AudioCaptureDevice[]>;
  /**
   * Begin capturing audio. The HOST owns the capture — the renderer, the
   * worklet and the loopback wiring are first-party code — and the plugin
   * receives PCM as data.
   *
   * A handle rather than an event subscription, and that is not a style
   * choice: the host's event bus broadcasts to every installed plugin, so
   * frames delivered as events would hand all of them the microphone. A handle
   * is addressed to the one plugin that asked.
   *
   * At most one capture runs host-wide, because the microphone and the system
   * mixer are single physical things. A second start is refused rather than
   * queued — a queued recording would begin at a moment nobody chose.
   */
  startAudioCapture(request: AudioCaptureRequest): Promise<AudioCaptureHandle>;
  /**
   * Attach one of this plugin's declared `floating` surfaces to the host's
   * floating dock — the single always-on-top window the host owns.
   *
   * THE PLUGIN DOES NOT GET A WINDOW. It gets a slot inside one, framed by
   * host chrome that is always around its pixels. Everything about the window
   * as a window — frameless, transparent, always-on-top, where on the screen
   * it sits, how large the whole dock may grow — is the host's and reaches no
   * parameter here. That split is the reason this capability can be offered at
   * all: a transparent borderless always-on-top surface a plugin could place
   * and size freely is a clickjacking primitive, and one framed by host chrome
   * at host-chosen coordinates is not.
   *
   * A handle rather than an event subscription, for the same reason
   * `startAudioCapture` is one: detach has to reach the ONE plugin whose card
   * went away, and the host's event bus broadcasts to all of them.
   *
   * The card inside is served by the same shell and the same `ave:plugin:*`
   * bridge a sidebar card gets, so it already has `callTool`, `emitEvent`,
   * config, storage and theme. A card that needs to talk to its plugin calls
   * the plugin's own tools.
   *
   * Refused, never silently downgraded, when the surface is not declared
   * `floating`, when its kind cannot render, or when the dock has no room
   * left. `dock-full` is a condition to retry; the rest are bugs in the
   * plugin, and the error code says which.
   */
  attachFloatingPanel(request: AttachFloatingPanelRequest): Promise<FloatingPanelHandle>;
  /**
   * Change one of this plugin's dock slots to a new height.
   *
   * The same operation {@link FloatingPanelHandle.resize} performs, exposed as
   * an addressable member because a handle's method cannot cross a process
   * boundary on its own — the wire carries calls by path, and a handle is a
   * host-side object the child holds a receipt for. Prefer the handle method;
   * this is what it delegates to.
   *
   * `panelId` is checked against the calling plugin's own slots, so naming
   * another plugin's panel is a refusal rather than a resize.
   *
   * Clamped exactly as the attach was, and resolves to what was applied.
   */
  resizeFloatingPanel(panelId: string, height: number): Promise<number>;

  /**
   * Open a hardened viewer BrowserWindow that loads `url` inside the
   * caller plugin's `persist:plugin-auth:<pluginId>` partition. The
   * existing cookies in that partition (typically deposited by an
   * earlier `openAuthWindow` IdP flow) make the load silent-SSO — no
   * re-login.
   *
   * **Caller binding:** the partition is decided by the host from the
   * plugin id of the HostApi instance — plugins cannot name a different
   * plugin's partition. A plugin cannot reuse another plugin's partition;
   * its own UI or auth flow must open a viewer through its own HostApi.
   *
   * **Allow-list:** `url` host must match `manifest.auth.partitionDomains`
   * (dot-boundary suffix). Navigation outside the allow-list is canceled
   * (`will-navigate` + `will-redirect` + `setWindowOpenHandler: deny`).
   * Downloads from the partition session are canceled. Cookies are never
   * read back into plugin code.
   *
   * **Capability gate:** `manifest.capabilities[]` must include
   * `external-auth-consumer`. Shared with `openAuthWindow` because both
   * surfaces grant access to the same plugin auth partition cookie jar.
   *
   * Resolves once the window has loaded or been closed; rejects only on a
   * hard load failure (not on user close).
   *
   * **Required (not `?`-optional)** unlike `hostFetch?` / `spawnWorker?` /
   * `getAppPreference?`. Plugins vendor this contract at an app release tag
   * and set `requires.minAppVersion` to a release serving every method they
   * use. This method is required so missing host wiring throws loudly instead
   * of being silently optional-chained. A silent fallback could route the
   * user to a less-protected window.
   */
  openAuthPartitionViewer(opts: {
    url: string;
    windowTitle?: string;
  }): Promise<void>;

  /**
   * Wipe all credential state (cookies, storage, cache, HTTP-auth, NTLM/
   * Kerberos credentials) from a `persist:plugin-auth:<pluginId>[:<sub>]`
   * partition. Use after a user-triggered sign-out so subsequent
   * `openAuthWindow` calls against the same partition cannot silently
   * SSO via residual IdP cookies — without this, plugin "sign out"
   * only clears the plugin's in-memory + on-disk shadow state while the
   * host Chromium keeps the federated session alive.
   *
   * **Allow-list:** the `partition` argument must equal
   * `persist:plugin-auth:<pluginId>` or `persist:plugin-auth:<pluginId>:<sub>`
   * for the calling plugin. The host rejects any other partition string.
   * Direct cross-plugin partition wipes are not allowed.
   *
   * **Capability gate:** `manifest.capabilities[]` must include
   * `external-auth-consumer` (same gate as `openAuthWindow`).
   *
   * **Required (not `?`-optional)** — plugin authors get a typed signature;
   * missing host wiring throws loudly. Silent optional-chain would let sign-out look
   * successful while leaving the partition populated.
   */
  clearAuthPartition(partition: string): Promise<void>;

  /**
   * Read the session cookies the host holds for this plugin in its auth
   * partition, scoped to the given request URLs. The counterpart to
   * `networkAccess.authCookiePartition` for flows that `hostFetch` cannot cover
   * — chiefly a browser/page-automation flow that must inject the session into
   * a separate browser context.
   *
   * The harvested cookie VALUES normally never leave the host (see
   * `openAuthWindow({ retainCookies: true })` + `authCookiePartition`); this is
   * the ONE gated, audited door through which a declaring plugin may read them
   * back, on demand, for the moment it needs to inject them — never persisted,
   * never held. Prefer `hostFetch` injection wherever the call is HTTP.
   *
   * `partitionSub` names only the `<sub>` segment; the host composes
   * `persist:plugin-auth:<pluginId>:<sub>`. Each returned group is the cookies
   * that apply to the corresponding `urls[i]`, scoped with the same rules the
   * host's `hostFetch` injector uses (including the legacy-http Secure
   * divergence). The host audits every call.
   *
   * **Capability gate:** `external-auth-consumer`, same as `openAuthWindow`.
   *
   */
  getAuthPartitionCookies(opts: {
    partitionSub: string;
    urls: string[];
  }): Promise<Array<{ url: string; cookies: AuthPartitionCookie[] }>>;

  /**
   * §B3 — Open an arbitrary external URL routed through the host's webView
   * preference policy (`settings.webView.preferredFlow`):
   *   - `"in-app"` → host opens a lightweight BrowserWindow (no cookieHosts /
   *     completionUrlPatterns enforcement; this is *not* `openAuthWindow`).
   *   - `"system-browser"` → host shells out to the OS default browser via
   *     Electron's `shell.openExternal`.
   *
   * The policy is read fresh from `settingsService` on every call so users can
   * toggle the preference live (no plugin reload required).
   *
   * Plugins SHOULD use this for "view this link" affordances (calendar webLink,
   * help docs, etc.) instead of calling `shell.openExternal` directly — that
   * bypasses the user's stated preference and breaks the §B1 toggle. The host
   * validates the scheme is http(s) (file:/javascript:/etc. are rejected with an
   * English error) before routing.
   *
   * **Required (not `?`-optional)** — plugins using this method set
   * `requires.minAppVersion` to a supporting app release. Plugins never reach
   * Electron `shell.openExternal` directly. Missing host wiring throws loudly
   * rather than being silently optional-chained.
   */
  openExternalUrl(url: string): Promise<void>;

  /**
   * Probe whether the OS resolver knows a host that only exists on a PRIVATE
   * network (corporate intranet / VPN / lab subnet). Resolves `true` when
   * `dns.lookup(host)` succeeds before the deadline, `false` on `ENOTFOUND` or
   * timeout — on-corp DNS resolves the private host, off-corp DNS returns
   * `ENOTFOUND`, and the async asymmetry is the signal.
   *
   * Semantics: a `dns.lookup` race against a `timeoutMs` deadline (default
   * 1500ms, host-clamped to sane bounds); fail-SAFE to `false` on timeout (a slow
   * user gate is worse than a false-negative); same-host in-flight dedup whose
   * lifetime is bound to the UNDERLYING lookup; NO result cache (corp↔off-corp
   * transitions must be observed live); an unref'd timer that never keeps the
   * event loop alive past app exit.
   *
   * `host` MUST be a bare hostname — a non-empty string with no scheme, port,
   * path, userinfo, or whitespace; URLs and `host:port` are rejected.
   *
   * This is a UX HINT, NOT a trust boundary. A local DNS spoof or split-DNS
   * environment can make an attacker-controlled host resolve `true`; plugins MUST
   * enforce real trust downstream (cookie/origin level) and never treat a `true`
   * here as authorization.
   *
   * **Required (not `?`-optional)** — plugins using this method set
   * `requires.minAppVersion` to a supporting app release. Missing host wiring
   * throws loudly instead of being silently optional-chained.
   */
  probePrivateHost(
    host: string,
    opts?: { timeoutMs?: number },
  ): Promise<boolean>;

  /**
   * §B3 — Read a host-level user preference exposed via the explicit
   * `HOST_PUBLIC_PREFERENCE_KEYS` allowlist (currently only
   * `"webView.preferredFlow"`).
   *
   * Returns `undefined` for unknown / non-allowlisted keys — never throws —
   * so plugins can safely probe forward-compat keys. The host emits a single
   * warn log per (pluginId, key, session) pair when a non-allowlisted key is
   * requested, to aid auditing without flooding logs.
   *
   * This is deliberately read-only and narrow: secrets, plugin configs, and
   * private host state stay invisible. To expose a new key, edit
   * `HOST_PUBLIC_PREFERENCE_KEYS` in `boot/steps/plugin-runtime.ts` and the
   * matching reader in this method's implementation — both must be updated.
   */
  getAppPreference?<T = unknown>(key: string): T | undefined;

  /**
   * Overlay trigger — ask the host to stage a plugin-authored suggestion in
   * the overlay. The plugin does not start a conversation turn; only a user's
   * overlay confirmation imports the prompt into the normal chat loop.
   *
   * Capability gate: `host:overlay`. The plugin's manifest must declare it;
   * otherwise the host returns `{ accepted: false, reason:
   * "capability_denied" }`. Callers should branch on `accepted` rather than
   * expecting an exception for this condition.
   *
   * Safety contract — caller MUST follow:
   * - `prompt` is a templated message, NOT raw third-party content (mail body,
   *   attachment text, etc.). The host has no way to validate this; injecting
   *   raw bodies makes prompt-injection trivial. Pass IDs in `context` and let
   *   the loop fetch raw content via tools.
   * - `source` MUST start with `overlay:` to keep the source-aware
   *   permission model (§6.3) able to enforce per-origin policies.
   * - `dedupeKey` should be set when the same observation can fire multiple
   *   times (e.g., the same mail re-emitting events) — host will reject the
   *   second call within a short window.
   * - `source` never contains `--`; that spelling is reserved for sources the
   *   host's alert pipeline mints.
   *
   * A plugin whose manifest declares {@link PluginManifest.alerts} uses this
   * method for one-time suggestions only: `source` must be one of
   * `alerts.suggestions` (`source_not_declared` otherwise), and each declared
   * source is accepted at most once per 30 days (`suggestion_limit`).
   */
  triggerConversation(
    spec: ConversationTriggerSpec,
  ): Promise<ConversationTriggerResult>;

  /**
   * Idempotency SOT query for suggestion-derived routines. Resolves `true` iff a
   * persisted routine carries an exactly-matching {@link RoutineRecord.source}
   * marker.
   *
   * LEAST-PRIVILEGE / least-surface: `source` MUST begin with
   * `suggestion:<callerPluginId>:` — the host returns `false` for any probe
   * outside the caller's own prefix, so plugin A cannot detect plugin B's
   * routines. The result is a plain boolean: no enumeration, no routine
   * contents, no cross-plugin surface. A plugin uses this as its "propose
   * once" gate (e.g. "have I already created my nightly-rescan routine?").
   */
  hasRoutineBySource(source: string): Promise<boolean>;

  /**
   * Post or refresh this plugin's recommended-work proposal for ONE declared
   * kind. The host persists it beside the Work Board and draws it as a card at
   * the top of that board; the card's start button runs the HOST's own
   * plan → approve → execute sequence over a work item the host composes.
   *
   * AUTHORIZATION is inferred from the plugin's `workProposals.kinds`
   * declaration in its installed manifest — the same declaration-as-
   * authorization rule `emittedEvents` uses for gated event namespaces. An
   * undeclared `kind` resolves `{ status: "kind_not_granted" }`; callers branch
   * on `status` rather than expecting a throw.
   *
   * UPSERT SEMANTICS. `(kind, key)` is the identity. Re-posting the same key
   * REFRESHES the card in place and re-arms its TTL. A DIFFERENT key while a
   * card is already open in that kind resolves `{ status: "slot_busy" }` — one
   * open proposal per declared kind is the ceiling, and it does not reset.
   *
   * A card the user dismissed or accepted stays closed through a refresh:
   * re-posting is not a way to put a closed card back in front of them.
   *
   * SAFETY CONTRACT: every string field is user-visible or LLM-visible. See
   * {@link WorkProposalUntrustedText} for what the caller must guarantee and
   * what the host can and cannot do about it.
   */
  proposeWork(input: WorkProposalInput): Promise<WorkProposalResult>;

  /**
   * Retract this plugin's own proposal because the condition it described no
   * longer holds — the mail was answered, the index was rescanned.
   *
   * Retraction is why this is a channel and not a notification: it is what lets
   * the board stay true over time without the host understanding any plugin's
   * domain. Scoped to the caller by construction — the id the host looks up is
   * derived from the CALLER's plugin id, so another plugin's proposal is not
   * addressable rather than merely refused.
   *
   * Resolves `false` when no matching open proposal existed. Idempotent.
   */
  withdrawWorkProposal(kind: string, key: string): Promise<boolean>;

  /**
   * Raise one alert of a kind declared in this plugin's `alerts` block.
   *
   * The plugin supplies typed slot values, never text: the host renders the
   * kind's declared summary and prompt in the app locale, decides whether the
   * alert reaches the user at all (the user's toggle for `<pluginId>:<kind>`,
   * a predecessor still installed, cooldown and rate budgets), and owns the
   * card, the OS notification and the conversation an accept starts.
   *
   * `(kind, key)` is the identity. Re-raising an open identity refreshes its
   * card (`refreshed`); an identity the user dismissed or accepted stays
   * closed for the card's lifetime (`closed`). Callers branch on `status`
   * rather than expecting a throw.
   */
  raiseAlert(input: AlertInput): Promise<AlertResult>;

  /**
   * Withdraw this plugin's open alert for `(kind, key)` because its condition
   * no longer holds. Scoped to the caller; resolves `false` when no such
   * alert is open.
   */
  withdrawAlert(kind: string, key: string): Promise<boolean>;

  /**
   * §8 Agent Approval System — main-process–side approval management.
   *
   * Plugins use this namespace to interact with the host's §8 ApprovalGate
   * from the main process. This is the correct path for plugin→host approval
   * responses. The renderer-only preload bridge (`context.bridge.approval`)
   * is NOT accessible from plugin handlers running in the main process.
   *
   * Usage pattern:
   *   await context.hostApi.agentApproval.respond(approvalId, choice, nonce, hmac)
   */
  agentApproval: {
    /**
     * Request an approval via the §8 ApprovalGate on behalf of this plugin.
     *
     * Records (requestId → issuerPluginId + scope) in the host's
     * ApprovalIssuerRegistry BEFORE calling the gate, so the respond path
     * can verify cross-plugin hijack and scope violations.
     *
     * The gate generates nonce + HMAC internally (confused-deputy defense).
     * Plugin MUST NOT compute nonce/HMAC.
     *
     * `scope` must be present in the host-approved install grant
     * (`approvedPluginAccess.agentApprovalScopes`), not merely in the manifest.
     */
    request(input: {
      toolName: string;
      args: unknown;
      reason: string;
      scope: string;
    }): Promise<ApprovalChoice>;
    /**
     * Resolve a pending ApprovalGate entry from the main process.
     *
     * Equivalent to `approvalGate.resolve(requestId, { requestId, choice, nonce, hmac })`.
     * Nonce + hmac MUST be echoed back verbatim as issued by the host with
     * the original ApprovalRequest — the gate re-verifies them before honoring
     * the decision. A mismatch forces deny-once (confused-deputy defense).
     *
     * §8 P0 security: host verifies (a) requestId was issued by this plugin,
     * (b) scope is still in the host-approved install grant. Violations throw.
     *
     * NOTE: a `list()` method was deliberately NOT exposed. Listing pending
     * approvals from a plugin would surface gate-issued nonces/HMACs (confused-deputy
     * material) to plugin code with no current use case.
     * If a future flow legitimately needs the snapshot, add it then with a
     * scoped capability — do not pre-expose dead surface.
     */
    respond(
      requestId: string,
      choice: ApprovalChoice,
      nonce?: string,
      hmac?: string,
    ): Promise<void>;
  };
}

/**
 * §8 ApprovalChoice — mirrors `approval-gate.ts` ApprovalChoice.
 * Defined here so the vendored public contract does not import the Host-private
 * `permissions/approval-gate.ts` module.
 */
export type ApprovalChoice =
  | "allow-once"
  | "allow-session"
  | "allow-always"
  | "deny-once"
  | "deny-always";

/**
 * Spec for `hostApi.triggerConversation()`. Passed by a plugin when it decides
 * a signal warrants staging a host overlay suggestion.
 */
export interface ConversationTriggerSpec {
  /** Templated message — NEVER raw third-party content. See safety contract. */
  prompt: string;
  /** Origin tag, must start with `overlay:` (e.g. `overlay:meeting-detection`). */
  source: string;
  /**
   * Side-channel metadata (IDs, references) recorded with the trigger.
   *
   * **Current limitation:** the host records `context` only into the
   * audit chain — the ConversationLoop pipeline (system-prompt builder,
   * tools, history) does NOT receive it. Plugins that need the LLM/tools
   * to act on an ID (e.g., `emailId`) MUST embed the ID in `prompt`
   * itself so it survives the trip into the loop. The field is kept on
   * the spec so future plumbing is non-breaking.
   */
  context?: Record<string, unknown>;
  /**
   * UI behaviour:
   * - `silent`         — run without surfacing to the user; only audit + result tools.
   * - `summary-only`   — show one-line completion notice (default).
   * - `user-visible`   — surface as if the user opened a turn, modal-style.
   *
   * Current limitation: all three values currently produce identical UI
   * behaviour; the field is recorded into audit only.
   *
   * Deprecated: accepted and ignored. A recurring alert declares its
   * visibility as an alert kind; this field leaves the spec in a later release.
   *
   * @deprecated
   */
  visibility?: "silent" | "summary-only" | "user-visible";
  /**
   * Routing hint for queueing when multiple triggers compete (audit-only today).
   *
   * Deprecated: accepted and ignored. Alert priority is a field of the alert
   * pipeline's input; this field leaves the spec in a later release.
   *
   * @deprecated
   */
  priority?: "low" | "normal" | "high";
  /** Suppress duplicate triggers for the same observation (window enforced by host). */
  dedupeKey?: string;
  /**
   * Overlay Runner — display title for the OverlayCard.
   * Defaults to the source tag with the `overlay:` prefix stripped.
   */
  title?: string;
  /**
   * Overlay Runner — one-line summary shown in the OverlayCard body.
   * Defaults to the first 200 chars of `prompt`.
   */
  summary?: string;
  /**
   * Overlay Runner — label for the OverlayCard primary action button.
   * Defaults to "확인하기" (host-level generic). Plugins targeting a
   * specific user intent (e.g. mail reply) may override per-detector
   * (예: `"답장하기"`).
   */
  primaryActionLabel?: string;
}

export interface ConversationTriggerResult {
  /** Whether the trigger was accepted for execution. */
  accepted: boolean;
  /**
   * When `accepted=false`, why:
   *   `capability_denied` — plugin lacks `host:overlay`.
   *   `invalid_source`    — `source` does not match `^overlay:[a-z][a-z0-9-]*$`,
   *                         contains `--` (reserved for host-minted alert
   *                         sources), `prompt` empty, or other shape problem.
   *   `duplicate`         — `dedupeKey` matched a recent trigger.
   *   `rate_limited`      — per-plugin call cap exceeded (sliding window).
   *   `loop_unavailable`  — ConversationLoop not yet bound (boot ordering, legacy).
   *   `source_not_declared` — the manifest declares an `alerts` block and
   *                         `source` is not one of its `alerts.suggestions`.
   *   `suggestion_limit`  — the manifest declares an `alerts` block and this
   *                         declared source was already accepted within the
   *                         last 30 days.
   */
  reason?:
    | "capability_denied"
    | "invalid_source"
    | "duplicate"
    | "rate_limited"
    | "loop_unavailable"
    | "source_not_declared"
    | "suggestion_limit";
  /** Echoed back so callers can correlate logs across plugin/host. */
  source: string;
  /**
   * Overlay Runner — present when `accepted=true` and the trigger was
   * staged as an OverlayItem instead of starting a fresh ConversationLoop.
   * Callers can use this to correlate the overlay item (e.g. for dismiss).
   */
  eventId?: string;
}

// ─── Alert declarations ──────────────────────────────────────────────────────
//
// An alert is a declared kind the host renders from declared templates: the
// plugin supplies typed slot values at raise time, never free text, and the
// host owns localisation, the card, the OS notification and the user's toggle
// for `<pluginId>:<kind>`.

/**
 * User-facing text in every locale the plugin ships, keyed by BCP 47-style
 * lowercase tag (`en`, `ko`, `pt-br`). `en` is required and is the fallback
 * when the app locale is missing.
 */
export type AlertLocaleText = { en: string } & Record<string, string>;

/** How far an alert reaches the user; a raise may only lower the declared level. */
export type AlertVisibility = "user-visible" | "summary-only" | "silent";

/**
 * One typed, bounded, untrusted value a raise supplies.
 *
 * - `text` — third-party text, capped at `maxLength` (at most 200).
 * - `list` — at most `maxItems` (at most 5) texts, each capped at `maxLength`
 *   (at most 120); joined with `; ` in the summary and one bullet line per
 *   item in the prompt.
 * - `ref` — an opaque id (`^[A-Za-z0-9+/=_-]{1,256}$`). A template never
 *   names it: the host appends it to the model-facing prompt as a wrapped
 *   footer line, so an id never reaches the card.
 *
 * A slot is required unless `optional` is true.
 */
export type AlertSlotDeclaration =
  | { kind: "text"; maxLength: number; optional?: boolean }
  | { kind: "list"; maxItems: number; maxLength: number; optional?: boolean }
  | { kind: "ref"; optional?: boolean };

/**
 * How a successor kind reads one toggle out of a retired plugin's config: the
 * list stored at `key` either names the disabled members (`listed:
 * "disabled"`) or the enabled ones (`listed: "enabled"`), and `values` are the
 * spellings — current and legacy — under which this kind appears in it.
 * `masterKey` names a boolean that, when false, turns the toggle off outright.
 */
export interface AlertInheritRule {
  key: string;
  listed: "enabled" | "disabled";
  values: string[];
  masterKey?: string;
}

/**
 * The predecessor a kind inherits the user's choice from. `sourceId` is the
 * marketplace source the predecessor is expected to come from, used only
 * until the host knows the retirement entry.
 */
export interface AlertInheritDeclaration {
  pluginId: string;
  sourceId: string;
  enabled: AlertInheritRule;
  /** Only for a kind that declares `osNotification`. */
  osNotification?: AlertInheritRule;
}

export interface AlertKindDeclaration {
  /** `^(?!.*--)[a-z][a-z0-9-]{0,30}[a-z0-9]$`, unique within the plugin. */
  id: string;
  /** At most 40 characters per locale. Also the OS notification title. */
  label: AlertLocaleText;
  /** At most 200 characters per locale. */
  description?: AlertLocaleText;
  /** The kind's toggle on a fresh install. An update never turns a kind on. */
  defaultEnabled: boolean;
  visibility: AlertVisibility;
  /** Absent = the kind never notifies the OS. */
  osNotification?: {
    defaultEnabled: boolean;
    bypassFocusGate?: boolean;
    /** Static text, no slots, at most 80 characters per locale. */
    body: AlertLocaleText;
  };
  /** The card's button label, at most 24 characters per locale. */
  actionLabel?: AlertLocaleText;
  /** At most 8 slots, named `^[a-z][a-zA-Z0-9]{0,31}$`. */
  slots?: Record<string, AlertSlotDeclaration>;
  /**
   * The card text: a template whose only dynamic parts are `{slot}`
   * references to `text` or `list` slots. No `<` or `>`. At most 200
   * characters per locale.
   */
  summary: AlertLocaleText;
  /**
   * The model-facing prompt the user's accept stages, under the same template
   * rules as `summary`. At most 1000 characters per locale. Every `text` and
   * `list` slot appears in the English summary or prompt.
   */
  prompt: AlertLocaleText;
  /** At most one predecessor. */
  inherits?: AlertInheritDeclaration[];
}

export interface PluginAlertsDeclaration {
  /** Why this plugin alerts at all; shown in Settings. At most 400 characters. */
  reasoning: string;
  /** 1..12 kinds. */
  kinds: AlertKindDeclaration[];
  /**
   * The only `source` values {@link PluginHostApi.triggerConversation} accepts
   * from this plugin: at most 4, each matching `^overlay:[a-z][a-z0-9-]*$`
   * with no `--`. Each is accepted at most once per 30 days.
   */
  suggestions?: string[];
}

/** One raise of a declared alert kind. */
export interface AlertInput {
  /** A kind id declared in this plugin's `alerts.kinds`. */
  kind: string;
  /**
   * The dedupe identity within the kind, `^[A-Za-z0-9_.:/@+=-]{1,256}$`.
   * Never rendered and never logged: the host keys the alert by a keyed hash
   * of it.
   */
  key: string;
  /** Values for the kind's declared slots: a string for `text` and `ref`, strings for `list`. */
  slots?: Record<string, string | string[]>;
  /** Default `normal`. `high` cards sort first; `low` never notifies the OS. */
  priority?: "low" | "normal" | "high";
  /** May only lower the kind's declared visibility. */
  visibility?: AlertVisibility;
  /** Card lifetime; the host clamps it to 1 minute – 7 days, default 24 hours. */
  ttlMs?: number;
}

export type AlertResult =
  | {
      status: "raised";
      alertId: string;
      delivered: { card: boolean; osNotification: boolean; toast: boolean };
    }
  /** An open alert with this identity was updated in place. */
  | { status: "refreshed"; alertId: string }
  /** `kind` is not among this plugin's declared kinds. */
  | { status: "kind_not_granted"; kind: string }
  /** The user turned this kind off. */
  | { status: "disabled_by_user" }
  /** A plugin this kind inherits from is still installed and not revoked. */
  | { status: "blocked_by_predecessor"; pluginId: string }
  /** The user dismissed or accepted this identity within its lifetime. */
  | { status: "closed" }
  /** The kind was raised within its cooldown window. */
  | { status: "cooldown" }
  /** This plugin raised faster than the host's budget allows. */
  | { status: "rate_limited" }
  /** Names the field that failed validation. Nothing was delivered. */
  | { status: "invalid"; field: string };

/** Fill config key `to` from a retired predecessor's config key `from`, or with a constant `value`. */
export type ConfigInheritDeclaration =
  | { pluginId: string; to: string; from: string }
  | { pluginId: string; to: string; value: unknown };

// ─── Recommended-work proposals ──────────────────────────────────────────────
//
// A proposal is a plugin saying "here is something I think you should
// consider", as a card the host draws at the top of its own Work Board. It is
// the plugin-facing door to a HOST domain that already exists: the host owns
// the storage, the card, the start action and the approval gate, and the
// plugin owns only the judgment that the condition holds.
//
// A proposal carries TEXT AND A KEY, and nothing executable. The card's start
// button drives the host's own plan → approve → execute sequence over an item
// the host composed, so there is no plugin-supplied action for the host to run
// and therefore no action-execution surface to bound.

/**
 * One declared proposal slot. The host namespaces it as `<pluginId>:<kind>`,
 * so a plugin cannot name another plugin's kind.
 */
export interface WorkProposalKind {
  /** `^[a-z][a-z0-9-]{0,31}$`, unique within the plugin. */
  id: string;
  /** What the user sees in the install disclosure and on the card. */
  label: string;
}

/** One "here is why I think so" row under a proposal's expandable detail. */
export interface WorkProposalEvidence {
  label: string;
  detail: string;
}

/** One "here is what stops this" row under a proposal's expandable detail. */
export interface WorkProposalBlocker {
  reason: string;
  /** What would unblock it, when the plugin knows. */
  resolution?: string;
}

/**
 * EVERY STRING A PLUGIN AUTHORED, in one place.
 *
 * SAFETY CONTRACT — the caller MUST follow it and the host CANNOT check it.
 * All of this is shown to the user as plain text, and `taskBrief` additionally
 * reaches an LLM as prompt text once the user starts the run. Every field MUST
 * be TEMPLATED text, never raw third-party content (a mail body, a document, an
 * attachment): pass identifiers inside `taskBrief` and let the run fetch the
 * content through tools.
 *
 * The host length-caps every field, renders each as plain text with no markdown
 * link or HTML surface, and wraps `taskBrief` in the plugin staged-origin
 * envelope — but none of that makes injected content safe to author. This is
 * the same limitation {@link ConversationTriggerSpec} documents, moved from
 * each plugin's own convention into the host's structure.
 *
 * Grouped as one interface deliberately: a reader asking "which of these came
 * from a plugin" reads the answer off the type instead of auditing per field.
 */
export interface WorkProposalUntrustedText {
  /** One line naming the work. Capped at 120 characters. */
  title: string;
  /** One line saying why it is being recommended. Capped at 200. */
  summary: string;
  /** The "current state" part of the expandable detail. Capped at 400. */
  state: string;
  /** The "evidence" part of the detail. At most 6 rows, each part capped at 200. */
  evidence: WorkProposalEvidence[];
  /** Why it cannot proceed, when it cannot. At most 4 rows. Empty when nothing blocks it. */
  blockers: WorkProposalBlocker[];
  /** Instruction text seeded into the run. NEVER rendered raw to the user. Capped at 2000. */
  taskBrief: string;
}

/**
 * What a plugin hands {@link PluginHostApi.proposeWork}. Text, a key, and
 * scheduling hints. No identity — the host binds `pluginId` from the HostApi
 * caller — and no action.
 */
export interface WorkProposalInput {
  /** One of this plugin's own declared, approved {@link WorkProposalKind} ids. */
  kind: string;
  /**
   * Plugin-scoped identity for the CONDITION this proposal describes — the
   * upsert and withdraw handle. Re-posting the same key refreshes the card;
   * a different key while that kind already holds an open card is refused.
   */
  key: string;
  title: string;
  summary: string;
  state: string;
  /** Omit for "nothing to show". The host stores an empty list, never a stand-in row. */
  evidence?: WorkProposalEvidence[];
  /** Omit when nothing blocks the work. */
  blockers?: WorkProposalBlocker[];
  taskBrief: string;
  /** Carried onto the work item if the user accepts. Defaults to `medium`. */
  priority?: "high" | "medium" | "low";
  /** ISO-8601 deadline carried onto the work item if the user accepts. */
  dueAt?: string;
  /**
   * How long the proposal stays open with no further contact from the plugin.
   * Host-clamped to [1 hour, 14 days]; 7 days when omitted. The TTL is what
   * sweeps an abandoned card when the plugin that posted it stops running.
   */
  ttlMs?: number;
}

/**
 * The persisted proposal. Everything the plugin did not supply is host-owned:
 * `id` is derived (`<pluginId>:<kind>:<hash(key)>`), `pluginId` comes from the
 * HostApi identity binding rather than the payload, and the timestamps are the
 * host's.
 */
export interface WorkProposal extends WorkProposalUntrustedText {
  id: string;
  kind: string;
  key: string;
  /** From the HostApi identity binding — a plugin cannot name another's. */
  pluginId: string;
  /** Display name from the installed manifest. */
  pluginLabel: string;
  priority: "high" | "medium" | "low";
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  /** `updatedAt + clamp(ttlMs)`. A proposal past this is swept on the next read. */
  expiresAt: string;
  /** Set when the user closed the card. Sticky per `id` — a re-post keeps it. */
  dismissedAt?: string;
  /** Set when the user accepted; links the proposal to the work item it became. */
  acceptedItemId?: number;
}

/**
 * Outcome of {@link PluginHostApi.proposeWork}. Callers branch on `status` —
 * a refusal is a value, never a throw, and never a coerced default.
 */
export type WorkProposalResult =
  | { status: "ok"; proposal: WorkProposal }
  /** `kind` is not among this plugin's declared, approved kinds. */
  | { status: "kind_not_granted"; kind: string }
  /** A DIFFERENT key is already open in this kind — the nag ceiling. */
  | { status: "slot_busy"; kind: string }
  /** Names the field that failed validation. Nothing was stored. */
  | { status: "invalid"; field: string }
  /** The host-wide proposal cap is full. */
  | { status: "cap_reached" }
  /** This plugin is upserting faster than the host's churn budget allows. */
  | { status: "rate_limited" };

export interface PluginRuntimeContext {
  pluginId: string;
  pluginRoot: string;
  hostRoot: string;
  /**
   * Absolute filesystem path to the plugin's writable data directory at
   * `<pluginsRoot>/<pluginId>/data/`. The host creates this directory before
   * calling the plugin factory. Plugins MUST write all runtime state (sessions,
   * caches, downloaded artefacts, oauth tokens, etc.) under this path so user
   * data stays scoped to the plugin and is not mixed with the install root
   * (`pluginRoot`) which is overwritten on plugin updates.
   */
  pluginDataDir: string;
  /**
   * Absolute path to the one directory this plugin may bind a Unix-domain
   * socket in, at `<pluginsRoot>/<pluginId>/sockets/`. The host creates it
   * before calling the plugin factory.
   *
   * WHY A SEPARATE DIRECTORY, when `pluginDataDir` is writable too. A confined
   * child's permission to create a socket is not its permission to create a
   * FILE: it is a separate ALLOW, scoped on macOS to one directory, and the
   * host has to register that directory with the sandbox BEFORE the child is
   * spawned. `sockets/` is the directory it registers. A socket bound anywhere
   * else — `pluginDataDir` included — is refused with `EPERM`.
   *
   * WHAT IT IS FOR. A plugin that has to be REACHED by a process it spawned
   * used to bind loopback TCP. A confined child cannot: on macOS the bind is
   * refused, and on Linux the child's network namespace puts loopback out of
   * reach from outside. A Unix socket is a filesystem object and has neither
   * problem. Pass the path to the other process and connect to it there.
   *
   * The plugin owns what it creates here, including cleanup: a socket file left
   * by a crashed run makes the next `listen()` fail with `EADDRINUSE`, so
   * unlink before binding.
   */
  pluginSocketDir: string;
  /**
   * The real user's home directory, as the HOST process sees it.
   *
   * WHY THE HOST HAS TO SAY. A confined child's `HOME` is a throwaway the
   * sandbox substitutes, so `os.homedir()` inside the child answers with a
   * directory that belongs to nobody. For code that uses the home as a WRITE
   * target that substitution is the point and should stay. For code that uses
   * it as PATH POLICY — "is this under the user's home", "is this someone
   * else's home", "is this `~/.ssh`" — the paths being judged came from the
   * USER, and against the throwaway every one of those answers turns to
   * `false`. A blocklist that quietly stops matching is worse than no
   * blocklist, because it still reports that it checked.
   *
   * This is an ANSWER, not a grant. Knowing where the home is does not make it
   * reachable: what a confined child may read is decided by the sandbox, and
   * the sensitive-path deny floor is anchored to this same directory host-side.
   */
  userHome: string;
  /**
   * The host's own storage root — `~/.ave`, or wherever `AVE_HOME` moved it.
   *
   * `pluginDataDir` already lives under this, so nothing here is newly visible.
   * It is named because a plugin that rebuilt the path from `os.homedir()` got
   * it wrong in two different ways: in a confined child the home is a
   * throwaway, and even in the main process `AVE_HOME` can point somewhere
   * else entirely. Host-owned files a plugin is separately granted — the
   * corporate CA bundle under `certs/`, the provisioned Python under
   * `runtime/` — hang off THIS root, and the envelope that grants them
   * resolves them the same way.
   */
  aveHome: string;
  config?: Record<string, unknown>;
  log: (message: string, meta?: unknown) => void;
  hostApi: PluginHostApi;
}

export type PluginToolHandler = (
  payload?: unknown,
) => Promise<unknown> | unknown;

export interface RuntimePlugin {
  start?: () => Promise<void> | void;
  /**
   * Runs only after this plugin's immutable Host generation is the active
   * pointer and any predecessor has completed retirement. Network discovery,
   * persisted-session recovery, write-capable workers, timers, and other
   * externally observable startup work belong here rather than in `start`,
   * which may execute while a replacement candidate is still hidden.
   * Failures are reported as degraded post-publish startup and never roll the
   * already-committed generation pointer back.
   */
  onPublished?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  handlers: Record<string, PluginToolHandler>;
  /**
   * Serve one of THIS plugin's manifest-declared `ui://` cards. The plugin IS the
   * MCP server, so it serves its own resource bytes — the host relays them (it
   * never resolves or reads a plugin-declared disk path itself).
   *
   * Called only for a `uri` the manifest declared in `uiResources[]` and whose
   * authority the host already verified (own-namespace-only). Returns the card
   * HTML. The `csp` comes from the MANIFEST — never from here: it is security
   * policy, statically reviewable and covered by `manifestSha256`, so a hook cannot
   * present a narrow CSP at review and widen it at runtime.
   *
   * Bounded by the host at the single {@link PluginRuntime.readUiResource}
   * chokepoint (timeout + HTML size cap, fail-closed). @optional
   */
  readUiResource?: (uri: string) => Promise<string> | string;
}

export type RuntimePluginFactory = (context: PluginRuntimeContext,
) => Promise<RuntimePlugin> | RuntimePlugin;


/** A microphone a plugin could ask the host to capture from. */
export interface AudioCaptureDevice {
  readonly deviceId: string;
  /** Empty until microphone access has been granted at least once. */
  readonly label: string;
}

/** What a plugin asks for when it attaches a card to the floating dock. */
export interface AttachFloatingPanelRequest {
  /** The id of one of this plugin's own manifest `ui` entries, slot `floating`. */
  readonly extensionId: string;
  /**
   * Requested slot height in device-independent pixels.
   *
   * Clamped by the host and never honoured verbatim — the dock's total height
   * is capped against the work area, so what a plugin gets depends on the
   * display and on what is already attached. Read {@link FloatingPanelHandle.height}
   * for what was actually applied. A non-finite or non-positive value is
   * REFUSED rather than defaulted, because silently opening a minimum-height
   * slot would hide the caller's arithmetic bug.
   */
  readonly height?: number;
}

/** Why a dock slot went away. */
export type DetachReason =
  /** The plugin called `detach()`. */
  | "requested"
  /** The user closed the dock. */
  | "user-closed"
  /** The card's renderer died. */
  | "renderer-gone"
  /** The plugin was stopped, reloaded or uninstalled. */
  | "plugin-stopped"
  /** The app is shutting down. */
  | "host-shutdown";

/** A live dock slot, as the plugin holds it. */
export interface FloatingPanelHandle {
  readonly panelId: string;
  /** The slot height the host actually used, after clamping. */
  readonly height: number;
  /**
   * Ask for a new height. Clamped identically; resolves to what was applied.
   *
   * Asynchronous because for an out-of-process plugin the dock is on the other
   * side of a wire. Rejects when the slot is already detached rather than
   * quietly doing nothing — a resize on a dead slot means the caller lost track
   * of it, and silence would let that keep happening.
   */
  resize(height: number): Promise<number>;
  /** Idempotent. */
  detach(): Promise<void>;
  /**
   * Fires exactly once, whoever detached the slot.
   *
   * The reason is what separates an orphaned session from a deliberate stop —
   * a recorder that hears `user-closed` has cleanup to do, and one that hears
   * nothing keeps recording into a window that is gone.
   */
  onDetached(listener: (reason: DetachReason) => void): void;
}

/** What a plugin asks for. Every field is data; none of it is a command. */
export interface AudioCaptureRequest {
  /** Samples per second of the delivered PCM, 8000–48000. */
  readonly sampleRate: number;
  /** How much audio each delivered frame carries, 20–1000 ms. */
  readonly frameMs: number;
  /** Open the microphone. */
  readonly microphone: boolean;
  /** Open system audio (loopback). */
  readonly systemAudio: boolean;
  /**
   * Which microphone, from {@link AudioCaptureDevice.deviceId}. Omitted means
   * the OS default. A named device that is gone is an ERROR rather than a
   * fallback to the default: silently recording a different microphone than
   * the user picked is worse than not recording.
   */
  readonly microphoneDeviceId?: string;
}

/** The answer to a successful the host's audio capture. */
export interface AudioCaptureStarted {
  readonly captureId: string;
  /**
   * Which sources actually opened — NOT which were asked for. Asking for both
   * and getting one is an ordinary outcome (no loopback support, permission
   * denied), and a plugin that cannot tell the difference will label a
   * microphone-only recording as a full one.
   */
  readonly opened: { readonly microphone: boolean; readonly systemAudio: boolean };
}

/** One delivered frame of captured audio. */
export interface AudioCaptureFrame {
  /**
   * 0-based and gap-free. A plugin that sees a gap has lost audio, and can say
   * so instead of producing a recording that is quietly short.
   */
  readonly seq: number;
  /** Mono, little-endian int16, at the requested sample rate. */
  readonly pcm: Uint8Array;
  /** Loudest absolute sample in this frame, 0..1. */
  readonly peak: number;
}

/** Why a capture stopped. */
export interface AudioCaptureEnd {
  readonly reason: "stopped" | "sources-lost" | "surface-lost";
  /** Present when the reason is a failure, absent when the plugin asked. */
  readonly detail?: string;
}

/**
 * A running capture.
 *
 * The same lifetime shape as a spawned worker — a host-allocated id,
 * subscriptions the caller opens, one way to end it — so an out-of-process
 * plugin reaches it over machinery that already exists.
 */
export interface AudioCaptureHandle {
  readonly captureId: string;
  /**
   * Which sources actually opened — NOT which were asked for. Asking for both
   * and getting one is an ordinary outcome (no loopback support, permission
   * denied), and a plugin that cannot tell the difference will label a
   * microphone-only recording as a full one.
   */
  readonly opened: { readonly microphone: boolean; readonly systemAudio: boolean };
  onFrame(listener: (frame: AudioCaptureFrame) => void): () => void;
  /** Fires exactly once, however the capture ended. */
  onEnd(listener: (end: AudioCaptureEnd) => void): () => void;
  stop(): Promise<void>;
}
