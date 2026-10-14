/**
 * Manifest validation — host-owned schema SOT + host cross-field MUST/SHOULD
 * checks. The manifest shape is validated against the host-owned
 * `schemas/plugin-manifest.schema.json`.
 *
 * Exported for unit testing and reuse by the PluginRuntime class.
 */

import { readFile } from "node:fs/promises";
import type { ValidateFunction } from "ajv";
// Host-owned manifest-shape source. The schema is imported as a
// bundler-visible JSON module so it inlines into the packaged main bundle —
// no runtime disk read, so no electron-builder `files`/asar gap can leave the
// packaged app unable to resolve it. Plugin repositories vendor this schema
// at an app release tag alongside the public contract.
import manifestSchema from "../../../schemas/plugin-manifest.schema.json" with { type: "json" };
import {
  AGENT_PLUGINS_SCHEMA_URL,
  AGENT_PLUGINS_TOP_LEVEL_FIELDS,
  AVE_EXTENSION_NAMESPACE,
  MAX_PLUGIN_ONBOARDING_HIGHLIGHTS,
  flattenAgentPluginsManifest,
  foreignManifestTopLevelFields,
} from "../public-contract.js";
import { parseSettingsPath } from "../../shared/settings-tabs.js";
import type {
  AlertInheritRule,
  AlertKindDeclaration,
  AlertLocaleText,
  ConfigInheritDeclaration,
  PluginManifest,
  PluginToolOperationPolicy,
  Tool,
} from "../types.js";
import { ALERT_RESERVED_PACKAGE_ID } from "../../shared/alerts-types.js";
import { PLUGIN_CONFIG_RESERVED_KEYS, sanitizePluginConfig } from "../../shared/plugin-config.js";
import { isPluginOverlaySource } from "../../shared/overlay-trigger-source.js";
import { isPackageName } from "../../marketplace/catalog/types.js";
import { SOURCE_ID_RE } from "../../marketplace/sources/official.js";
import { toolVisibility } from "./tool-visibility.js";
import { createLogger } from "../../lib/logger.js";
import { normalizeAllowedHosts } from "../../main/host-allow-list.js";
import { PROCESS_ENTRY_FIRST_APP_VERSION } from "../process-entry.js";
import { checkProcessEntryArgument, checkProcessEntryEnvironmentValue } from "../resolve-bundled-argv.js";
import { isSafeMcpEnvironmentName } from "../../mcp/safe-names.js";
import { compareSemver } from "../../shared/semver-compare.js";
import {
  HOST_SECRET_READ_MAX_ITEMS,
  findHostSecretReadListViolation,
  isAllowedHostSecretKey } from "../../shared/marketplace-package-assets.js";
import {
  MAX_PROPOSAL_KINDS,
  PROPOSAL_KIND_LABEL_MAX,
  PROPOSAL_KIND_PATTERN,
} from "../../shared/work-board-types.js";
import { resolvePluginContributionDeclarations } from "../plugin-contributions.js";
import { errorMessage } from "../../shared/error-message.js";
import { resolveAddFormats, resolveAjv } from "../config-schema.js";
import { TOOL_NAME_PATTERN, isValidToolName } from "../../tools/types.js";
import { canonicalJSON } from "../secret-access/canonical-json.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { sandboxDeclarationProblem } from "../sandbox-authority.js";
import { HOST_PROTOCOL_VERSIONS_SERVED } from "../isolation/host-api-wire.js";
import { isRecord } from "../../shared/is-record.js";

// Re-exported here so manifest/plugin-loading consumers can import the
// minAppVersion gate error + IPC code alongside the other manifest contracts.
/**
 * Stable SemVer pattern (MAJOR.MINOR.PATCH, no leading zeros, no pre-release,
 * no build metadata). This TS const mirrors the `version` / `minAppVersion`
 * pattern in the host-owned `schemas/plugin-manifest.schema.json` (the SOT) and
 * the per-plugin `publish.yml` tag-validation step. Updating any of those copies
 * MUST update the others (cross-repo, see `host-plugin-contract-sync` rule).
 */
const STABLE_SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** `requires.hostProtocol`, mirroring its `pattern` in the manifest schema. */
const HOST_PROTOCOL_VERSION_RE = /^[1-9][0-9]*$/;
// The Tool._meta key that carries a signed operation policy. Error paths name
// the same constant so a namespace rename cannot leave a stale key in messages.
const OPERATION_POLICY_META_KEY = "ave/operationPolicy" as const;

// #893 — the allow-listed host-secret key shapes a manifest's
// `hostSecrets.read[]` may name have ONE definition,
// `isAllowedHostSecretKey` (src/shared/marketplace-package-assets.ts). It mirrors the JSON-schema
// constraint as defence-in-depth so a plugin manifest cannot install a wider
// allowlist than the schema permits — a claim that only holds while there is a
// single definition, so do NOT re-derive the shape here.
const log = createLogger("plugin-runtime");

export function formatUnknownErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Extension fields the current manifest no longer has. An installed manifest
 * from an earlier release may still carry one, so drop it before validation
 * and warn once per plugin. New packages must omit retired fields.
 */
const RETIRED_EXTENSION_FIELDS = ["installPolicy", "publisher", "notificationEvents"] as const;
const retiredFieldsWarned = new Set<string>();

function dropRetiredExtensionFields(doc: unknown, parsed: PluginManifest, pid: string, path: string): void {
  const extensions = typeof doc === "object" && doc !== null ? (doc as { extensions?: unknown }).extensions : undefined;
  const ave = typeof extensions === "object" && extensions !== null ? (extensions as Record<string, unknown>)[AVE_EXTENSION_NAMESPACE] : undefined;
  if (typeof ave !== "object" || ave === null) return;
  const found = RETIRED_EXTENSION_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(ave, field));
  if (found.length === 0) return;
  for (const field of found) {
    delete (ave as Record<string, unknown>)[field];
    delete (parsed as unknown as Record<string, unknown>)[field];
  }
  if (retiredFieldsWarned.has(pid)) return;
  retiredFieldsWarned.add(pid);
  log.warn(`[manifest] ${path}: ignoring retired field(s) ${found.join(", ")}; the plugin's next update removes them`);
}

export function getDeclaredEmittedEvents(manifest: Pick<PluginManifest, "emittedEvents">,
): string[] {
  if (!Array.isArray(manifest.emittedEvents)) return [];
  return [...new Set(
    manifest.emittedEvents.filter((e): e is string => typeof e === "string" && e.length > 0,
      ),
  ),
  ];
}

/**
 * The proposal kinds a plugin is authorized to post — read off its installed
 * manifest, the same way {@link getDeclaredEmittedEvents} reads its emit
 * authorization. There is no separate capability string and no separate grant
 * record: the declaration IS the grant, and the installed manifest is what the
 * user approved (its canonical hash is pinned into the registry at install).
 *
 * FAIL-CLOSED AND ALL-OR-NOTHING. A malformed block returns the EMPTY list
 * rather than the entries that happened to parse. A partially-honoured consent
 * declaration would grant slots the user never read a label for.
 */
export function getDeclaredWorkProposalKinds(
  manifest: Pick<PluginManifest, "workProposals">,
  pluginId?: string,
): string[] {
  const block = manifest.workProposals;
  if (block === undefined) return [];
  const reject = (why: string): string[] => {
    log.warn(
      `Plugin manifest '${pluginId ?? "?"}': workProposals declaration rejected (${why}) — the plugin may post no work proposals`,
    );
    return [];
  };
  if (typeof block !== "object" || block === null) return reject("not an object");
  if (block.reasoning !== undefined && typeof block.reasoning !== "string") {
    return reject("reasoning is not a string");
  }
  if (!Array.isArray(block.kinds)) return reject("kinds is not an array");
  if (block.kinds.length === 0) return reject("kinds is empty");
  if (block.kinds.length > MAX_PROPOSAL_KINDS) {
    return reject(`more than ${MAX_PROPOSAL_KINDS} kinds`);
  }
  const ids: string[] = [];
  for (const kind of block.kinds) {
    if (typeof kind?.id !== "string" || !PROPOSAL_KIND_PATTERN.test(kind.id)) {
      return reject(`kind id '${String(kind?.id)}' does not match ${PROPOSAL_KIND_PATTERN.source}`);
    }
    if (
      typeof kind.label !== "string"
      || kind.label.trim().length === 0
      || kind.label.length > PROPOSAL_KIND_LABEL_MAX
    ) {
      return reject(`kind '${kind.id}' has no usable label`);
    }
    if (ids.includes(kind.id)) return reject(`duplicate kind id '${kind.id}'`);
    ids.push(kind.id);
  }
  return ids;
}

// ─── Alert declarations ─────────────────────────────────────────────────────
//
// The schema bounds every field; these readers re-check each bound (a plugin
// built against a stale schema must not widen what it declares, the rule
// `hostSecrets` follows) and add the cross-field rules the schema cannot
// state: template references, unused slots, duplicate ids and `to` keys.

const MAX_ALERT_KINDS = 12;
const MAX_ALERT_SUGGESTIONS = 4;
const MAX_ALERT_SLOTS = 8;
const MAX_ALERT_LOCALES = 16;
const MAX_CONFIG_INHERITS = 16;
const MAX_INHERIT_VALUES = 32;
const ALERT_REASONING_MAX = 400;
const ALERT_KIND_ID_RE = /^(?!.*--)[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const ALERT_SLOT_NAME_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;
const ALERT_LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const ALERT_LOCALE_MAX = 35;
const MANIFEST_CONFIG_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TEXT_SLOT_MAX = 200;
const LIST_SLOT_MAX_ITEMS = 5;
const LIST_SLOT_ITEM_MAX = 120;
const INHERIT_VALUE_MAX = 64;

/** Thrown inside the readers below; never escapes them. */
class DeclarationRefused extends Error {}

function refuse(why: string): never {
  throw new DeclarationRefused(why);
}

/** Length in code points, the unit JSON Schema's `maxLength` counts. */
function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) refuse(`${at} has unknown field '${key}'`);
  }
}

function checkLocaleText(
  value: unknown,
  at: string,
  max: number,
  rules: { template?: boolean; singleLine?: boolean } = {},
): AlertLocaleText {
  if (!isRecord(value)) refuse(`${at} is not a locale map`);
  const locales = Object.keys(value);
  if (locales.length === 0 || locales.length > MAX_ALERT_LOCALES) {
    refuse(`${at} has ${locales.length} locales; 1 to ${MAX_ALERT_LOCALES} are allowed`);
  }
  if (!Object.hasOwn(value, "en")) refuse(`${at} has no 'en' text`);
  for (const locale of locales) {
    if (locale.length > ALERT_LOCALE_MAX || !ALERT_LOCALE_RE.test(locale)) {
      refuse(`${at} has an invalid locale '${locale}'`);
    }
    const text = value[locale];
    if (typeof text !== "string" || text.trim().length === 0) refuse(`${at}.${locale} is empty`);
    if (codePointLength(text) > max) refuse(`${at}.${locale} is longer than ${max} characters`);
    if (rules.template && /[<>]/.test(text)) refuse(`${at}.${locale} contains '<' or '>'`);
    if (rules.singleLine && /[\r\n]/.test(text)) refuse(`${at}.${locale} contains a line break`);
  }
  return value as AlertLocaleText;
}

function checkBoolean(value: unknown, at: string, optional = false): void {
  if (optional && value === undefined) return;
  if (typeof value !== "boolean") refuse(`${at} is not a boolean`);
}

function checkBoundedInteger(value: unknown, at: string, max: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    refuse(`${at} is not an integer from 1 to ${max}`);
  }
}

/** A top-level plugin config key an inheritance may read or write. */
function checkConfigKey(value: unknown, at: string): void {
  if (
    typeof value !== "string"
    || !MANIFEST_CONFIG_KEY_RE.test(value)
    || PLUGIN_CONFIG_RESERVED_KEYS.has(value)
  ) {
    refuse(`${at} is not a usable config key`);
  }
}

/** Whether `value` survives the plugin-config sanitiser unchanged, so writing it later cannot fail or reshape it. */
function isStoredConfigValue(value: unknown): boolean {
  try {
    return canonicalJSON(sanitizePluginConfig({ value })) === canonicalJSON({ value });
  } catch {
    return false;
  }
}

/**
 * The `{slot}` references in one template, or a refusal when a brace is not
 * part of a well-formed reference — a stray brace would otherwise render as
 * literal text the plugin could shape into something that reads like a slot.
 */
function templateReferences(text: string, at: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(/\{([^{}]*)\}|[{}]/g)) {
    if (match[1] === undefined) refuse(`${at} has an unmatched brace`);
    refs.push(match[1]);
  }
  return refs;
}

function checkInheritRule(value: unknown, at: string): AlertInheritRule {
  if (!isRecord(value)) refuse(`${at} is not an object`);
  checkKeys(value, ["key", "listed", "values", "masterKey"], at);
  checkConfigKey(value.key, `${at}.key`);
  if (value.listed !== "enabled" && value.listed !== "disabled") refuse(`${at}.listed is not "enabled" or "disabled"`);
  const values = value.values;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_INHERIT_VALUES) {
    refuse(`${at}.values is not a list of 1 to ${MAX_INHERIT_VALUES} spellings`);
  }
  for (const item of values) {
    if (typeof item !== "string" || item.length === 0 || codePointLength(item) > INHERIT_VALUE_MAX || /[\r\n]/.test(item)) {
      refuse(`${at}.values has an unusable spelling`);
    }
  }
  if (new Set(values).size !== values.length) refuse(`${at}.values repeats a spelling`);
  if (value.masterKey !== undefined) checkConfigKey(value.masterKey, `${at}.masterKey`);
  return value as unknown as AlertInheritRule;
}

function checkAlertKind(kind: unknown, at: string): AlertKindDeclaration {
  if (!isRecord(kind)) refuse(`${at} is not an object`);
  checkKeys(kind, [
    "id", "label", "description", "defaultEnabled", "visibility", "osNotification",
    "actionLabel", "slots", "summary", "prompt", "inherits",
  ], at);
  if (typeof kind.id !== "string" || !ALERT_KIND_ID_RE.test(kind.id)) {
    refuse(`${at}.id '${String(kind.id)}' does not match ${ALERT_KIND_ID_RE.source}`);
  }
  const where = `kind '${kind.id}'`;
  checkLocaleText(kind.label, `${where} label`, 40, { singleLine: true });
  if (kind.description !== undefined) checkLocaleText(kind.description, `${where} description`, 200);
  checkBoolean(kind.defaultEnabled, `${where} defaultEnabled`);
  if (kind.visibility !== "user-visible" && kind.visibility !== "summary-only" && kind.visibility !== "silent") {
    refuse(`${where} visibility is not user-visible, summary-only or silent`);
  }
  if (kind.osNotification !== undefined) {
    const os = kind.osNotification;
    if (!isRecord(os)) refuse(`${where} osNotification is not an object`);
    checkKeys(os, ["defaultEnabled", "bypassFocusGate", "body"], `${where} osNotification`);
    checkBoolean(os.defaultEnabled, `${where} osNotification.defaultEnabled`);
    checkBoolean(os.bypassFocusGate, `${where} osNotification.bypassFocusGate`, true);
    const body = checkLocaleText(os.body, `${where} osNotification.body`, 80, { singleLine: true });
    // Static text: a brace would read as a slot the host never fills.
    if (Object.values(body).some((text) => /[{}]/.test(text))) {
      refuse(`${where} osNotification.body names a slot; it must be static text`);
    }
  }
  if (kind.actionLabel !== undefined) checkLocaleText(kind.actionLabel, `${where} actionLabel`, 24, { singleLine: true });

  // Slot kind by name; only text and list slots may appear in a template.
  const slotKinds = new Map<string, "text" | "list" | "ref">();
  if (kind.slots !== undefined) {
    if (!isRecord(kind.slots)) refuse(`${where} slots is not an object`);
    const names = Object.keys(kind.slots);
    if (names.length > MAX_ALERT_SLOTS) refuse(`${where} declares more than ${MAX_ALERT_SLOTS} slots`);
    for (const name of names) {
      if (!ALERT_SLOT_NAME_RE.test(name)) refuse(`${where} slot name '${name}' does not match ${ALERT_SLOT_NAME_RE.source}`);
      const slot = kind.slots[name];
      const slotAt = `${where} slot '${name}'`;
      if (!isRecord(slot)) refuse(`${slotAt} is not an object`);
      checkBoolean(slot.optional, `${slotAt} optional`, true);
      if (slot.kind === "text") {
        checkKeys(slot, ["kind", "maxLength", "optional"], slotAt);
        checkBoundedInteger(slot.maxLength, `${slotAt} maxLength`, TEXT_SLOT_MAX);
      } else if (slot.kind === "list") {
        checkKeys(slot, ["kind", "maxItems", "maxLength", "optional"], slotAt);
        checkBoundedInteger(slot.maxItems, `${slotAt} maxItems`, LIST_SLOT_MAX_ITEMS);
        checkBoundedInteger(slot.maxLength, `${slotAt} maxLength`, LIST_SLOT_ITEM_MAX);
      } else if (slot.kind === "ref") {
        checkKeys(slot, ["kind", "optional"], slotAt);
      } else {
        refuse(`${slotAt} kind is not text, list or ref`);
      }
      slotKinds.set(name, slot.kind);
    }
  }

  const summary = checkLocaleText(kind.summary, `${where} summary`, 200, { template: true, singleLine: true });
  const prompt = checkLocaleText(kind.prompt, `${where} prompt`, 1000, { template: true });
  const usedInEnglish = new Set<string>();
  for (const [field, template] of [["summary", summary], ["prompt", prompt]] as const) {
    for (const [locale, text] of Object.entries(template)) {
      for (const ref of templateReferences(text, `${where} ${field}.${locale}`)) {
        const slotKind = slotKinds.get(ref);
        if (slotKind === undefined) refuse(`${where} ${field}.${locale} names undeclared slot '{${ref}}'`);
        // A ref reaches the model only as the host's wrapped footer line.
        if (slotKind === "ref") refuse(`${where} ${field}.${locale} names ref slot '{${ref}}'; ref slots are never templated`);
        if (locale === "en") usedInEnglish.add(ref);
      }
    }
  }
  for (const [name, slotKind] of slotKinds) {
    if (slotKind !== "ref" && !usedInEnglish.has(name)) {
      refuse(`${where} declares slot '${name}' that neither English template uses`);
    }
  }

  if (kind.inherits !== undefined) {
    if (!Array.isArray(kind.inherits) || kind.inherits.length !== 1) {
      refuse(`${where} inherits must name exactly one predecessor`);
    }
    const entry: unknown = kind.inherits[0];
    const entryAt = `${where} inherits[0]`;
    if (!isRecord(entry)) refuse(`${entryAt} is not an object`);
    checkKeys(entry, ["pluginId", "sourceId", "enabled", "osNotification"], entryAt);
    if (!isPackageName(entry.pluginId)) refuse(`${entryAt}.pluginId is not a plugin id`);
    if (typeof entry.sourceId !== "string" || !SOURCE_ID_RE.test(entry.sourceId)) {
      refuse(`${entryAt}.sourceId is not a source id`);
    }
    checkInheritRule(entry.enabled, `${entryAt}.enabled`);
    if (entry.osNotification !== undefined) {
      if (kind.osNotification === undefined) {
        refuse(`${entryAt}.osNotification maps a toggle the kind does not declare`);
      }
      checkInheritRule(entry.osNotification, `${entryAt}.osNotification`);
    }
  }
  return kind as unknown as AlertKindDeclaration;
}

interface DeclaredAlerts {
  readonly kinds: readonly AlertKindDeclaration[];
  readonly suggestions: readonly string[];
}

function checkAlertsBlock(block: unknown): DeclaredAlerts {
  if (!isRecord(block)) refuse("not an object");
  checkKeys(block, ["reasoning", "kinds", "suggestions"], "the block");
  if (
    typeof block.reasoning !== "string"
    || block.reasoning.trim().length === 0
    || codePointLength(block.reasoning) > ALERT_REASONING_MAX
  ) {
    refuse(`reasoning is not a string of 1 to ${ALERT_REASONING_MAX} characters`);
  }
  if (!Array.isArray(block.kinds) || block.kinds.length === 0 || block.kinds.length > MAX_ALERT_KINDS) {
    refuse(`kinds is not a list of 1 to ${MAX_ALERT_KINDS} kinds`);
  }
  const ids = new Set<string>();
  const kinds = block.kinds.map((kind, i) => {
    const checked = checkAlertKind(kind, `kinds[${i}]`);
    if (ids.has(checked.id)) refuse(`duplicate kind id '${checked.id}'`);
    ids.add(checked.id);
    return checked;
  });
  let suggestions: string[] = [];
  if (block.suggestions !== undefined) {
    if (!Array.isArray(block.suggestions) || block.suggestions.length > MAX_ALERT_SUGGESTIONS) {
      refuse(`suggestions is not a list of at most ${MAX_ALERT_SUGGESTIONS} sources`);
    }
    for (const source of block.suggestions) {
      if (typeof source !== "string" || !isPluginOverlaySource(source)) {
        refuse(`suggestion '${String(source)}' is not an overlay source a plugin may use`);
      }
    }
    if (new Set(block.suggestions).size !== block.suggestions.length) refuse("suggestions repeats a source");
    suggestions = block.suggestions as string[];
  }
  // A copy, so what was checked is what is granted even if the manifest
  // object is edited after load.
  return structuredClone({ kinds, suggestions });
}

/**
 * Read results by block object: a refused block warns once, and the gates
 * that consult it on every call do not re-validate it.
 */
const declaredAlertsByBlock = new WeakMap<object, DeclaredAlerts | null>();

function readDeclaredAlerts(manifest: Pick<PluginManifest, "alerts">, pluginId: string | undefined): DeclaredAlerts | null {
  const block: unknown = manifest.alerts;
  if (block === undefined) return null;
  const cacheable = typeof block === "object" && block !== null;
  if (cacheable) {
    const cached = declaredAlertsByBlock.get(block);
    if (cached !== undefined) return cached;
  }
  let result: DeclaredAlerts | null;
  try {
    result = checkAlertsBlock(block);
  } catch (err) {
    if (!(err instanceof DeclarationRefused)) throw err;
    log.warn(
      `Plugin manifest '${pluginId ?? "?"}': alerts declaration rejected (${err.message}) — the plugin may raise no alerts and trigger no overlay suggestion`,
    );
    result = null;
  }
  if (cacheable) declaredAlertsByBlock.set(block, result);
  return result;
}

/**
 * The alert kinds a plugin is authorized to raise, read off its installed
 * manifest. As {@link getDeclaredWorkProposalKinds}: the declaration is the
 * grant, and a block malformed in any entry grants nothing.
 */
export function getDeclaredAlertKinds(
  manifest: Pick<PluginManifest, "alerts">,
  pluginId?: string,
): readonly AlertKindDeclaration[] {
  return readDeclaredAlerts(manifest, pluginId)?.kinds ?? [];
}

/**
 * The overlay sources `triggerConversation` accepts from this plugin, or
 * `null` when its manifest has no `alerts` block and the call is not scoped.
 *
 * FAIL-CLOSED: a manifest that carries the block counts as declared even
 * when the block is refused, and then declares no source at all, so a
 * deliberately broken block cannot lift the limit.
 */
export function getDeclaredSuggestionSources(
  manifest: Pick<PluginManifest, "alerts">,
  pluginId?: string,
): readonly string[] | null {
  if (manifest.alerts === undefined) return null;
  return readDeclaredAlerts(manifest, pluginId)?.suggestions ?? [];
}

const configInheritsByList = new WeakMap<object, readonly ConfigInheritDeclaration[] | null>();

function checkConfigInherits(list: unknown): readonly ConfigInheritDeclaration[] {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CONFIG_INHERITS) {
    refuse(`not a list of 1 to ${MAX_CONFIG_INHERITS} entries`);
  }
  const targets = new Set<string>();
  list.forEach((entry: unknown, i) => {
    const at = `[${i}]`;
    if (!isRecord(entry)) refuse(`${at} is not an object`);
    const hasFrom = Object.hasOwn(entry, "from");
    const hasValue = Object.hasOwn(entry, "value");
    if (hasFrom === hasValue) refuse(`${at} must have exactly one of 'from' and 'value'`);
    checkKeys(entry, ["pluginId", "to", hasFrom ? "from" : "value"], at);
    if (!isPackageName(entry.pluginId)) refuse(`${at}.pluginId is not a plugin id`);
    checkConfigKey(entry.to, `${at}.to`);
    if (hasFrom) checkConfigKey(entry.from, `${at}.from`);
    else if (!isStoredConfigValue(entry.value)) refuse(`${at}.value is not a value a plugin config can hold`);
    if (targets.has(entry.to as string)) refuse(`two entries fill '${String(entry.to)}'`);
    targets.add(entry.to as string);
  });
  return structuredClone(list) as ConfigInheritDeclaration[];
}

/**
 * The plugin's `configInherits` entries: `[]` when it declares none, `null`
 * when the list is refused. A refused list applies nothing, so it can never
 * count as a completed migration either.
 */
export function getDeclaredConfigInherits(
  manifest: Pick<PluginManifest, "configInherits">,
  pluginId?: string,
): readonly ConfigInheritDeclaration[] | null {
  const list: unknown = manifest.configInherits;
  if (list === undefined) return [];
  const cacheable = typeof list === "object" && list !== null;
  if (cacheable) {
    const cached = configInheritsByList.get(list);
    if (cached !== undefined) return cached;
  }
  let result: readonly ConfigInheritDeclaration[] | null;
  try {
    result = checkConfigInherits(list);
  } catch (err) {
    if (!(err instanceof DeclarationRefused)) throw err;
    log.warn(
      `Plugin manifest '${pluginId ?? "?"}': configInherits declaration rejected (${err.message}) — no config is inherited`,
    );
    result = null;
  }
  if (cacheable) configInheritsByList.set(list, result);
  return result;
}

/**
 * Compile the host-owned plugin manifest schema into an AJV validator.
 *
 * The manifest-shape source is `schemas/plugin-manifest.schema.json`, imported
 * as a bundler-visible JSON module. If the schema cannot be compiled, plugin
 * loading must fail closed.
 *
 * AJV uses `strict`, `strictRequired:false`, `allErrors`, `allowUnionTypes`,
 * and `ajv-formats`. Test-time assertions pin the resulting accept/reject
 * behavior against this compiled validator
 * (`manifest-validator-host-sot.test.ts`).
 */
export async function buildManifestValidator(): Promise<ValidateFunction> {
  try {
    const AjvCtor = resolveAjv();
    const ajv = new AjvCtor({
      strict: true,
      strictRequired: false,
      allErrors: true,
      allowUnionTypes: true,
    });
    resolveAddFormats()(ajv);
    return ajv.compile(manifestSchema);
  } catch (err) {
    // Fail closed — an uncompilable schema aborts plugin loading rather than
    // degrading to an unvalidated (permissive) load path.
    throw new Error(
      `Host plugin manifest validator failed to compile: ${formatUnknownErrorMessage(err)}`,
    );
  }
}

/**
 * Materialize a validated manifest into the pure form every host consumer reads
 * (SoT §2.3). Two defaulting sites, both pure (no IO):
 *   1. a tool that omits `_meta.ui.visibility` gets the STANDARD SEP-1865
 *      default `["model","app"]`; an explicit `[]` is REJECTED (R6 fail-closed —
 *      never widened to dual). `tool-visibility.ts` depends on this being the
 *      sole tool-visibility defaulting step, so output tools ALWAYS carry an
 *      explicit non-empty `_meta.ui.visibility`.
 *   2. `name` defaults to `id` when the (schema-optional) manifest omits it, so
 *      a parsed manifest always carries a name at runtime.
 * Formerly a standalone exported helper in `../types.js`; inlined here as the
 * single load-time materializer now that no other consumer needs it.
 */
function materializeManifest(manifest: PluginManifest): PluginManifest {
  const DUAL = ["model", "app"] as const;
  const tools = manifest.tools.map((t): Tool => {
    const vis = t._meta?.ui?.visibility;
    if (vis === undefined) {
      return {
        ...t,
        _meta: { ...t._meta, ui: { ...t._meta?.ui, visibility: [...DUAL] } },
      };
    }
    if (vis.length === 0) {
      throw new Error(
        `[manifest:${manifest.id}] tool '${t.name}': _meta.ui.visibility is [] — ` +
          "a tool must be reachable by ≥1 surface; empty is rejected (SoT §2.2/§2.3)",
      );
    }
    return t;
  });
  return { ...manifest, tools, name: manifest.name ?? manifest.id };
}

/**
 * Map an internal field path onto the place in the file an author actually has
 * to edit. The internal manifest is flat and the document is not, so a bare
 * "entry" would send someone looking at a top level that does not have it.
 *
 * Derived from {@link AGENT_PLUGINS_TOP_LEVEL_FIELDS} rather than a second list
 * of its own: one definition of what "portable" means, so the two cannot drift.
 */
function onDiskFieldPath(fieldPath: string): string {
  if (fieldPath === "id") return "name";
  const root = fieldPath.split(/[.[]/, 1)[0] ?? fieldPath;
  if (AGENT_PLUGINS_TOP_LEVEL_FIELDS.includes(root)) return fieldPath;
  return `extensions["${AVE_EXTENSION_NAMESPACE}"].${fieldPath}`;
}

const documentSha256ByManifest = new WeakMap<PluginManifest, string>();

/**
 * Tie a manifest to the `plugin.json` document it was read from. The
 * registry's `manifestSha256` pins that document (every installer hashes the
 * file as authored), not the flat projection the runtime works with, so a
 * gate that compares a running plugin against its pin needs the document's
 * digest, which the projection cannot reproduce.
 */
export function recordManifestDocument(manifest: PluginManifest, document: unknown): void {
  documentSha256ByManifest.set(manifest, sha256Hex(canonicalJSON(document)));
}

/** The canonical sha256 of the document `manifest` was read from; null when it was not read from one. */
export function manifestDocumentSha256(manifest: PluginManifest): string | null {
  return documentSha256ByManifest.get(manifest) ?? null;
}

/**
 * The `process` rules the manifest schema does not express (§9.7 P3, one
 * source each): the reserved environment names, the path rules for `args` and
 * `env` values, and the app-version floor. The command's own shape — inside
 * the plugin root, no `=` — is the schema's `pattern`.
 */
function checkProcessEntryShape(
  processRaw: unknown,
  minAppVersion: unknown,
  fail: (fieldPath: string, reason: string, example: string) => never,
): void {
  if (!isRecord(processRaw)) {
    fail("process", "must be an object with a 'command'", `"process": { "command": "./bin/plugin" }`);
  }
  const { args, env } = processRaw as { args?: unknown; env?: unknown };
  if (args !== undefined) {
    if (!Array.isArray(args)) fail("process.args", "must be an array of strings", `"args": ["--stdio"]`);
    (args as unknown[]).forEach((value, index) => {
      try {
        checkProcessEntryArgument(value as string, `argument ${index}`);
      } catch (error) {
        fail(
          `process.args[${index}]`,
          `${errorMessage(error)}; a path is named as \${PLUGIN_ROOT}/<path> or \${PLUGIN_DATA}/<path>`,
          `"args": ["\${PLUGIN_ROOT}/vendor", "--level=1"]`,
        );
      }
    });
  }
  if (env !== undefined) {
    if (!isRecord(env)) fail("process.env", "must be an object of string values", `"env": { "VENDOR_DIR": "\${PLUGIN_ROOT}/vendor" }`);
    for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
      if (!isSafeMcpEnvironmentName(name)) {
        fail(
          `process.env.${name}`,
          "names a variable the host reserves (a loader, interpreter, launcher or proxy setting, or PLUGIN_ROOT/PLUGIN_DATA, in any letter case); "
            + "set it from your launcher inside the plugin's own process instead",
          `"env": { "VENDOR_DIR": "\${PLUGIN_ROOT}/vendor" }`,
        );
      }
      try {
        checkProcessEntryEnvironmentValue(value as string, `value of ${name}`);
      } catch (error) {
        fail(
          `process.env.${name}`,
          errorMessage(error),
          `"env": { "VENDOR_DIR": "\${PLUGIN_ROOT}/vendor" }`,
        );
      }
    }
  }
  if (typeof minAppVersion !== "string" || !STABLE_SEMVER_RE.test(minAppVersion)
    || compareSemver(minAppVersion, PROCESS_ENTRY_FIRST_APP_VERSION) < 0) {
    fail(
      "requires.minAppVersion",
      `a plugin with a 'process' entry must require Ave ${PROCESS_ENTRY_FIRST_APP_VERSION} or newer, the first release that runs one`,
      `"requires": { "minAppVersion": "${PROCESS_ENTRY_FIRST_APP_VERSION}", "hostProtocol": "3" }`,
    );
  }
}

/**
 * Parse and fully validate a plugin.json manifest file.
 *
 * The file on disk is an Agent Plugins 1.0.0 document; every host consumer
 * reads the flat {@link PluginManifest}. This is the sole boundary between the
 * two: {@link flattenAgentPluginsManifest} projects the document, the AJV
 * validation runs against the *document* (so the schema stays the SOT for what
 * an author writes), and everything after that works on the projection.
 *
 * Runs the Host-owned AJV schema validation, then materializes each tool's surface
 * visibility and the `name` default via `materializeManifest` (SoT §3.1), then
 * runs host cross-field MUST checks against the pure `Tool[]`. Returns the
 * fully-materialized {@link PluginManifest} every host consumer reads. Throws
 * with a descriptive message on any failure.
 */
export async function parsePluginJson(
  path: string,
  validator: ValidateFunction,
): Promise<PluginManifest> {
  // Detailed, per-field error messages shaped as
  //   "Invalid plugin manifest '<pluginId>' at '<fieldPath>': <reason>. Example: <correction>"
  const raw = await readFile(path, "utf-8");
  // `doc` is the file as authored — the Agent Plugins 1.0.0 shape the schema
  // describes, and therefore the thing the validator must see. `parsed` is the
  // flat internal projection every check below and every consumer downstream
  // reads. Validating the document rather than the projection keeps the schema
  // honest as the SOT for what a plugin author writes (and keeps the host
  // agreeing with the CI job that validates the same file with the same schema).
  let doc: unknown;
  let parsed: PluginManifest;
  // Taken before anything below edits `doc` (retired fields are dropped from
  // it in place): the registry pins the file as authored.
  let authoredSha256: string;
  try {
    doc = JSON.parse(raw) as unknown;
    authoredSha256 = sha256Hex(canonicalJSON(doc));
    parsed = flattenAgentPluginsManifest(doc);
  } catch (err) {
    throw new Error(
      `Invalid plugin manifest '<unknown>' at '${path}': JSON parse error (${(err as Error).message}). ` +
        `Example: {"$schema":"${AGENT_PLUGINS_SCHEMA_URL}","name":"sample-plugin",` +
        `"version":"1.0.0","description":"Sample plugin.","extensions":{"${AVE_EXTENSION_NAMESPACE}":` +
        `{"displayName":"Sample","entry":"dist/index.js",` +
        `"tools":[{"name":"sample_ping","inputSchema":{"type":"object","properties":{}}}]}}}`,
    );
  }
  const pid =
    typeof parsed?.id === "string" && parsed.id.length > 0
      ? parsed.id
      : "<unknown>";
  const fail = (fieldPath: string, reason: string, example: string): never => {
    throw new Error(
      `Invalid plugin manifest '${pid}' at '${onDiskFieldPath(fieldPath)}' (${path}): ${reason}. Example: ${example}`,
    );
  };

  if (!validator) {
    throw new Error("Host plugin manifest validator is required");
  }

  // Agent Plugins 1.0.0 is explicit that a client reports and ignores unknown
  // top-level fields rather than refusing the plugin over another vendor's
  // data. The projection already drops them; this is the "reports" half, kept
  // here rather than inside the projection so that projection stays pure and
  // can be vendored unchanged.
  const foreign = foreignManifestTopLevelFields(doc);
  if (foreign.length > 0) {
    log.warn(
      `[manifest] ${path}: ignoring non-portable top-level field(s) ` +
        `${foreign.join(", ")} — Agent Plugins 1.0.0 reserves the manifest top ` +
        `level; client-specific data belongs under ` +
        `extensions["${AVE_EXTENSION_NAMESPACE}"]`,
    );
  }

  const networkAccessRaw: unknown = parsed.networkAccess;
  if (
    networkAccessRaw &&
    typeof networkAccessRaw === "object" &&
    !Array.isArray(networkAccessRaw)
  ) {
    const allowedDomainsRaw = (networkAccessRaw as { allowedDomains?: unknown })
      .allowedDomains;
    if (
      Array.isArray(allowedDomainsRaw) &&
      allowedDomainsRaw.every(
        (entry): entry is string => typeof entry === "string",
      )
    ) {
      try {
        // Normalize IN PLACE rather than replacing `parsed.networkAccess`.
        // `parsed` is a shallow projection of the document, so this object is
        // the same one the document holds — and the AJV run below validates the
        // DOCUMENT. Replacing the field would normalize only the projection and
        // leave validation looking at the raw value, which the schema's
        // lowercase-hostname rule would then reject: a manifest that loads today
        // would stop loading, and the normalization step would be doing nothing.
        (networkAccessRaw as { allowedDomains: string[] }).allowedDomains =
          // `allowLoopback` admits the `localhost` / `127.0.0.1` / `::1`
          // literals a plugin uses to declare a local endpoint (a user-run
          // inference server or proxy). Declaring one is not reachability —
          // `host-fetch-guard.ts` still decides that — but the literal has to
          // survive normalization or the declaration cannot be written at all.
          normalizeAllowedHosts(allowedDomainsRaw, { allowLoopback: true });
      } catch (err) {
        fail(
          "networkAccess.allowedDomains",
          errorMessage(err),
          `"networkAccess": { "allowedDomains": ["api.example.com"], "reasoning": "Why this plugin needs host-mediated egress." }`,
        );
      }
    }
    // `authCookiePartition` names only the `<sub>` segment of this plugin's own
    // auth partition; the host composes `persist:plugin-auth:<pluginId>:<sub>`.
    // Reject a colon so a declaration cannot smuggle extra partition segments
    // (or escape into another namespace) past the host's composition.
    const authCookieRaw = (networkAccessRaw as { authCookiePartition?: unknown })
      .authCookiePartition;
    if (authCookieRaw !== undefined) {
      if (
        typeof authCookieRaw !== "string" ||
        authCookieRaw.length === 0 ||
        authCookieRaw.includes(":")
      ) {
        fail(
          "networkAccess.authCookiePartition",
          "must be a non-empty string naming a single partition sub-namespace (no ':')",
          `"networkAccess": { "authCookiePartition": "portal" }`,
        );
      }
    }
  }

  if (Array.isArray(parsed.ui)) {
    for (let i = 0; i < parsed.ui.length; i += 1) {
      const rawExt = parsed.ui[i] as unknown;
      if (!rawExt || typeof rawExt !== "object" || Array.isArray(rawExt)) {
        fail(
          `ui[${i}]`,
          "must be an object",
          `"ui": [{ "slot": "settings", "kind": "embedded-page", "page": "settings" }]`,
        );
      }
      const ext = rawExt as Record<string, unknown>;
      const kind = ext.kind;
      const missing: string[] = [];
      if (kind === "embedded-module") {
        if (typeof ext.entry !== "string" || ext.entry.length === 0)
          missing.push("entry");
        if (typeof ext.exportName !== "string" || ext.exportName.length === 0)
          missing.push("exportName");
      } else if (kind === "embedded-page") {
        if (typeof ext.page !== "string" || ext.page.length === 0)
          missing.push("page");
      }
      if (missing.length > 0) {
        fail(
          `ui[${i}]`,
          `kind="${String(kind)}" missing required field(s): ${missing.join(", ")}`,
          kind === "embedded-module"
            ? `"ui": [{ "kind": "embedded-module", "entry": "dist/ui.js", "exportName": "PluginUi" }]`
            : `"ui": [{ "kind": "embedded-page", "page": "settings" }]`,
        );
      }
    }
  }

  dropRetiredExtensionFields(doc, parsed, pid, path);

  if (!validator(doc)) {
    // Enrich the error so users can act on it. Pre-fix AJV's default text
    // for additional-properties was "/ must NOT have additional properties"
    // — never named WHICH property was rejected, leaving users stuck (#737).
    // Now we name the offending field(s) and append a reinstall hint when
    // it's the additional-property case (typical when the host schema tightens
    // and a stale plugin install carries a deprecated field).
    const rawAjvErrors = validator.errors ?? [];
    const ajvErrors = rawAjvErrors;
    const additionalProps: string[] = [];
    for (const e of ajvErrors) {
      if (e.keyword === "additionalProperties") {
        const extra = (e.params as { additionalProperty?: string } | undefined)
          ?.additionalProperty;
        if (typeof extra === "string") additionalProps.push(extra);
      }
    }
    const errs = ajvErrors
      .map((e) => {
        if (e.keyword === "additionalProperties") {
          const extra = (
            e.params as { additionalProperty?: string } | undefined
          )?.additionalProperty;
          return `${e.instancePath || "/"} unknown property: '${extra ?? "?"}'`;
        }
        // Preserve AJV's `params` for non-additionalProperties errors so
        // users see the actionable detail (allowed enum values, expected
        // type, regex pattern, etc.). Pre-fix dropped params silently —
        // a `pattern` mismatch on `version` would say "must match pattern"
        // without showing the pattern itself.
        const base = `${e.instancePath || "/"} ${e.message ?? ""}`.trim();
        const params =
          e.params &&
          typeof e.params === "object" &&
          Object.keys(e.params).length > 0
            ? ` (${JSON.stringify(e.params)})`
            : "";
        return `${base}${params}`;
      })
      .join("; ");
    const hint =
      additionalProps.length > 0
        ? ` — the manifest contains ${additionalProps.length === 1 ? "a field" : "fields"} that the current Host schema no longer allows. The plugin may need an update — try reinstalling from the marketplace.`
        : "";
    throw new Error(
      `[manifest:${pid}] schema validation failed (${path}): ${errs}${hint}`,
    );
  }

  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    fail("id", "must be a non-empty string", `"id": "meeting-recorder"`);
  }
  // Defence in depth for callers using a partial validator: the authoritative
  // schema accepts kebab-case only, so every dotted form is invalid.
  if (typeof parsed.id === "string" && parsed.id.includes(".")) {
    fail(
      "id",
      `value '${parsed.id}' must use kebab-case; dotted ids are not allowed — manifest_schema`,
      `"id": "meeting-recorder"`,
    );
  }
  // Stable SemVer only — same regex as the host schema and the per-plugin
  // publish.yml tag-validation step. Anchored on both ends so `1.2.3.4`,
  // pre-release tags (`1.2.3-rc1`), build metadata (`1.2.3+abc`), and
  // leading zeros (`01.2.3`) all fail at this gate instead of slipping
  // through and tripping the publish workflow later.
  if (
    typeof parsed.version !== "string" ||
    !STABLE_SEMVER_RE.test(parsed.version)
  ) {
    fail(
      "version",
      "must be a stable SemVer string MAJOR.MINOR.PATCH (no pre-release or build metadata, no leading zeros)",
      `"version": "1.0.0"`,
    );
  }
  // Exactly one way to produce the plugin's process. The schema's `oneOf`
  // says the same; this is the loud, field-named copy for a validator that is
  // more permissive than the host's own.
  const hasEntry = (parsed as { entry?: unknown }).entry !== undefined;
  const processRaw: unknown = (parsed as { process?: unknown }).process;
  if (hasEntry && processRaw !== undefined) {
    fail(
      "process",
      "a plugin declares exactly one of 'entry' and 'process', not both",
      `"process": { "command": "./bin/plugin" }`,
    );
  }
  if (processRaw === undefined) {
    if (typeof parsed.entry !== "string" || parsed.entry.length === 0) {
      fail(
        "entry",
        "must be a non-empty relative path to the plugin ESM entry, or declare 'process' instead",
        `"entry": "dist/index.js"`,
      );
    }
  } else {
    checkProcessEntryShape(processRaw, (parsed as { requires?: { minAppVersion?: unknown } }).requires?.minAppVersion, fail);
  }
  if (!Array.isArray(parsed.tools)) {
    fail(
      "tools",
      "must be an array of pure MCP tool objects",
      `"tools": [{ "name": "sample_ping", "inputSchema": { "type": "object", "properties": {} } }]`,
    );
  }
  // #885 Phase R — pure v6 only. Each `tools[]` entry MUST be an MCP Tool OBJECT.
  // A pre-v6 manifest declared `tools` as a list of name STRINGS (paired with the
  // now-removed `toolSchemas`/`uiActions` maps). Reject it here with an actionable
  // message instead of letting it fall through to the downstream tool-name loop,
  // which would spread a bare string into a nameless object and throw the
  // confusing "Invalid tool name 'undefined'" (security-review nitpick a). The
  // The host schema rejects that legacy shape. Keep this host-side guard
  // as a loud, author-facing error if validation is ever invoked with a custom
  // validator that is accidentally more permissive than the Host source of truth.
  const preV6ToolIdx = (parsed.tools as unknown[]).findIndex(
    (t) => typeof t !== "object" || t === null || Array.isArray(t),
  );
  if (preV6ToolIdx !== -1) {
    fail(
      `tools[${preV6ToolIdx}]`,
      "must be an MCP Tool object — this plugin targets a pre-v6 contract " +
        "(legacy tools[] name strings + toolSchemas/uiActions); update to the app release contract",
      `"tools": [{ "name": "sample_ping", "inputSchema": { "type": "object", "properties": {} } }]`,
    );
  }
  if (
    typeof parsed.description !== "string" ||
    parsed.description.length === 0
  ) {
    fail(
      "description",
      "must be a non-empty string (used in inactive-plugin catalog)",
      `"description": "One-line summary of what this plugin does."`,
    );
  }
  // #885 v6 — materialize each tool's `_meta.ui.visibility` (and the `name`
  // default) into the pure `PluginManifest` every host check below reads (the
  // standard `["model","app"]` default is filled in here, an explicit `[]` is
  // rejected). From here on all tool checks read `manifest.tools: Tool[]` —
  // never `parsed.tools`.
  const manifest = materializeManifest(parsed);

  const sandboxProblem = sandboxDeclarationProblem(manifest);
  if (sandboxProblem) {
    fail("sandbox", `${sandboxProblem} — manifest_schema`, `"sandbox": { "read": [] }`);
  }

  // Contribution paths and owner-local IDs are security-bearing cross-field
  // contracts that JSON Schema alone cannot normalize or collision-check.
  // Validate them before any runtime or subsystem can observe the manifest.
  resolvePluginContributionDeclarations(manifest);

  // Tool names exposed to LLMs must satisfy TOOL_NAME_PATTERN (the schema's
  // `tools[].name` rule — kept as defence-in-depth against an accidentally stale
  // compiled Host validator, same rationale as the hostSecrets/version re-checks).
  // One pass also builds the by-name index reused by auth cross-field checks and
  // REJECTS duplicates: the old three-map shape got name-uniqueness for free
  // (object keys), but two `tools[]` objects may now share a `name`, which would
  // throw at runtime in the loader methodMap and make auth lookups ambiguous
  // (u2 §1.4.1).
  const byName = new Map<string, Tool>();
  for (let i = 0; i < manifest.tools.length; i += 1) {
    const tool = manifest.tools[i];
    const name = tool?.name;
    if (!isValidToolName(name)) {
      throw new Error(
        `Invalid tool name '${String(name)}' in plugin '${pid}' at 'tools[${i}].name' (${path}): ` +
          `tool names must match ${TOOL_NAME_PATTERN.source} (start with letter/underscore, then letters/digits/underscores). ` +
          `Example: "tools": [{ "name": "sample_tool", ... }] (not "sample.tool")`,
      );
    }
    if (byName.has(name)) {
      fail(
        `tools[${i}].name`,
        `duplicate tool name '${name}'`,
        `each tools[] entry needs a unique name`,
      );
    }
    byName.set(name, tool);
  }

  // Signed operation restrictions are colocated on each pure MCP Tool. This
  // preserves manifest==wire and prevents a second tool-name keyed action map.
  const operationPolicies = new Map<string, PluginToolOperationPolicy>();
  for (const [toolName, tool] of byName) {
    const policy = tool._meta?.[OPERATION_POLICY_META_KEY];
    if (!policy) continue;
    operationPolicies.set(toolName, policy);
    const policyPath = `tools.${toolName}._meta.${OPERATION_POLICY_META_KEY}`;
    if (policy.discriminant !== "operation") {
      fail(
        `${policyPath}.discriminant`,
        "must equal 'operation'",
        `"discriminant": "operation"`,
      );
    }
    const operationNames = Object.keys(policy.operations ?? {});
    if (operationNames.length === 0) {
      fail(
        `${policyPath}.operations`,
        "must declare at least one operation",
        `"operations": { "list": { "kind": "read", "minimumRisk": "read" } }`,
      );
    }
    const inputSchema = tool.inputSchema as {
      required?: unknown;
      properties?: Record<string, unknown>;
    };
    if (
      !Array.isArray(inputSchema.required) ||
      !inputSchema.required.includes("operation")
    ) {
      fail(
        `tools.${toolName}.inputSchema.required`,
        "must require the top-level operation discriminant",
        `"required": ["operation"]`,
      );
    }
    const operationSchema = inputSchema.properties?.operation as
      | { type?: unknown; const?: unknown; enum?: unknown }
      | undefined;
    if (!operationSchema || operationSchema.type !== "string") {
      fail(
        `tools.${toolName}.inputSchema.properties.operation`,
        "must be a top-level string schema",
        `"operation": { "type": "string", "enum": [${operationNames.map((name) => JSON.stringify(name)).join(", ")}] }`,
      );
    }
    const governedOperationSchema = operationSchema as {
      type: "string";
      const?: unknown;
      enum?: unknown;
    };
    const schemaOperations = Array.isArray(governedOperationSchema.enum)
      ? governedOperationSchema.enum.filter(
          (value): value is string => typeof value === "string",
        )
      : typeof governedOperationSchema.const === "string"
        ? [governedOperationSchema.const]
        : [];
    if (
      schemaOperations.length !== operationNames.length ||
      [...schemaOperations]
        .sort()
        .some((name, index) => name !== [...operationNames].sort()[index])
    ) {
      fail(
        `tools.${toolName}.inputSchema.properties.operation`,
        `enum/const must exactly match ${OPERATION_POLICY_META_KEY} operations`,
        `use exactly ${JSON.stringify(operationNames.sort())}`,
      );
    }
    const visibility = toolVisibility(tool);
    for (const [operation, rule] of Object.entries(policy.operations)) {
      if (rule.appVisible === true && !visibility.includes("app")) {
        fail(
          `${policyPath}.operations.${operation}.appVisible`,
          "cannot expand a Tool that is not app-visible",
          `set tools[]. _meta.ui.visibility to include "app" or remove appVisible`,
        );
      }
      if (
        rule.successfulResultStatuses !== undefined &&
        rule.kind !== "read"
      ) {
        fail(
          `${policyPath}.operations.${operation}.successfulResultStatuses`,
          "is valid only for a read operation",
          `remove successfulResultStatuses or set kind to "read"`,
        );
      }
    }
    for (const [operation, rule] of Object.entries(policy.operations)) {
      if (!rule.requiresRead) continue;
      const readTool = byName.get(rule.requiresRead.tool);
      const readPolicy =
        operationPolicies.get(rule.requiresRead.tool) ??
        readTool?._meta?.[OPERATION_POLICY_META_KEY];
      if (!readTool || !readPolicy) {
        fail(
          `${policyPath}.operations.${operation}.requiresRead.tool`,
          `must reference a declared Tool with ${OPERATION_POLICY_META_KEY}`,
          `reference a governed tool in tools[]`,
        );
      }
      for (const readOperation of rule.requiresRead.operations) {
        if (readPolicy!.operations[readOperation]?.kind !== "read") {
          fail(
            `${policyPath}.operations.${operation}.requiresRead.operations`,
            `'${readOperation}' must reference a read operation`,
            `choose a kind='read' operation from '${rule.requiresRead.tool}'`,
          );
        }
      }
    }
  }


  // `startupTimeoutMs` 는 *plugin instance.start() lifecycle hook 의 timeout* 만
  // 통제한다 — manifest 의 tool name list 자동 invoke 메커니즘 (runManifestStartupTools,
  // 2026-05-14 폐기) 의 잔재가 아님. plugin self-start 가 SoT 인 모델에서 host runtime
  // 의 `Promise.race` 에 묶이는 유일한 시간 가드.
  if (parsed.startupTimeoutMs !== undefined) {
    if (
      typeof parsed.startupTimeoutMs !== "number" ||
      !Number.isInteger(parsed.startupTimeoutMs) ||
      parsed.startupTimeoutMs <= 0
    ) {
      fail(
        "startupTimeoutMs",
        "must be a positive integer (ms)",
        `"startupTimeoutMs": 8000`,
      );
    }
  }

  // #885 v6 — auth trio visibility (u2-host-consumers §1.2). Enforces that each
  // auth-lifecycle tool is app-only-visibility — never model-visible — with ONE
  // intra-object array read per auth ref. This single rule consolidates the pre-v6
  // #1554 leak guard (auth must never be model-callable) and the pre-v6
  // auth-must-be-app-visible check (a dual method is now ONE object with visibility
  // ["model","app"], so the old overlap shape no longer exists). Each ref must name
  // a declared tool whose visibility is EXACTLY ["app"]: `exactlyApp` folds app ∈
  // vis (UI-invokable) AND model ∉ vis (#1554: never model-callable). A dual
  // ["model","app"] auth tool is REJECTED — that IS the load-bearing #1554
  // invariant ("a 'model' tool NEVER reaches the app-only dispatch path"), now
  // enforced at declaration time. `toolVisibility` is a pure reader
  // (normalize already materialized any omitted visibility to dual UPSTREAM), so
  // an auth tool that forgot to declare visibility arrives here as explicit dual
  // → fails `exactlyApp` → rejected (fail-closed; a silently-defaulted auth tool
  // must never become model-callable). See architecture.md §9.4a.
  if (manifest.auth) {
    for (const key of ["statusTool", "loginTool", "logoutTool"] as const) {
      const ref = manifest.auth[key];
      if (ref === undefined) continue; // logoutTool is optional
      if (typeof ref !== "string") {
        fail(
          `auth.${key}`,
          "must be a string",
          `"auth": { "statusTool": "ms_status", "loginTool": "ms_login" }`,
        );
      }
      const tool = byName.get(ref);
      if (!tool) {
        fail(
          `auth.${key}`,
          `references tool '${ref}' which is not declared in tools[]`,
          `add a tools[] entry named '${ref}' with "_meta": { "ui": { "visibility": ["app"] } }`,
        );
      }
      // `fail()` returns never; re-assert the binding — narrowing through the
      // local `fail` arrow is lossy in this file (see the hostSecrets re-assert).
      const authTool: Tool = tool as Tool;
      const vis = toolVisibility(authTool);
      const exactlyApp = vis.length === 1 && vis[0] === "app";
      if (!exactlyApp) {
        fail(
          `auth.${key}`,
          `tool '${ref}' must have visibility exactly ["app"] (host-managed auth is UI-only, never model-callable) — got ${JSON.stringify(vis)}`,
          `set "_meta": { "ui": { "visibility": ["app"] } } on the '${ref}' tool`,
        );
      }
    }

    // architecture.md §9.4a: when `auth` is declared, the renderer's
    // `usePluginAuthStatuses` hook subscribes to `${manifest.id}.auth.changed`
    // (literal id, NO `_`↔`-` normalization). R3 (0.5.2) — the host now
    // AUTO-DERIVES that exact event name and registers the renderer bridge
    // whenever `auth` is present (`collectPluginEventTypes` in
    // boot/steps/ipc-bridge.ts), so the author no longer has to re-list the
    // fixed derived string in emittedEvents[]. The old soft-warn that nagged
    // for a missing `${id}.auth.changed` declaration is therefore removed —
    // even an author who declares the WRONG (underscore-mirrored) form still
    // gets the correct dash-form bridge from the host, eliminating the #131
    // regression class entirely.

    // NOTE (#885 v6): the old #1554 `auth ∉ tools[]` hard-fail is folded into
    // the `exactlyApp` visibility check above — an auth tool declared with
    // model-visibility (the pure-form analog of "appears in tools[]") is
    // rejected by `exactlyApp` (`model ∉ vis` required). No separate leak guard.
  }

  // hostSecrets.read[] schema enforcement. Re-check at host load time so a
  // plugin using older vendored contract files cannot widen its allowlist by adding a
  // non-`llm.apiKey.*` entry. Reason tag is `manifest_schema` to mirror the
  // host's other supply-chain-visibility audit tags.
  const hostSecretsRaw: unknown = (parsed as { hostSecrets?: unknown })
    .hostSecrets;
  if (hostSecretsRaw !== undefined) {
    if (
      hostSecretsRaw === null ||
      typeof hostSecretsRaw !== "object" ||
      Array.isArray(hostSecretsRaw)
    ) {
      fail(
        "hostSecrets",
        "must be an object with optional `read` array",
        `"hostSecrets": { "read": ["llm.apiKey.openai"] }`,
      );
    }
    const readListRaw: unknown = (hostSecretsRaw as { read?: unknown }).read;
    if (readListRaw !== undefined) {
      if (!Array.isArray(readListRaw)) {
        fail(
          "hostSecrets.read",
          "must be an array of strings",
          `"hostSecrets": { "read": ["llm.apiKey.openai"] }`,
        );
      }
      const readArr = readListRaw as unknown[];
      for (let i = 0; i < readArr.length; i += 1) {
        const key = readArr[i];
        if (typeof key !== "string") {
          fail(
            `hostSecrets.read[${i}]`,
            "must be a string",
            `"hostSecrets": { "read": ["llm.apiKey.openai"] }`,
          );
        }
        // `fail()` returns `never`, but TS's narrowing through the
        // arrow-function call path is sometimes lossy — re-assert via a
        // local typed binding so the regex test below sees `key: string`.
        const keyStr: string = key as string;
        if (!isAllowedHostSecretKey(keyStr)) {
          fail(
            `hostSecrets.read[${i}]`,
            `value '${keyStr}' does not match the allowed host-secret pattern (manifest_schema). Accepted forms are \`llm.apiKey.<vendor>\` and \`llm.marketplaceProvider.<presetId>.apiKey\``,
            `"hostSecrets": { "read": ["llm.apiKey.openai", "llm.marketplaceProvider.future-router.apiKey"] }`,
          );
        }
      }
      // Collection bounds. AJV already enforces `maxItems`/`uniqueItems` from
      // the vendored schema on this path, so this is defence-in-depth — but it
      // is what makes the "no wider allowlist than the schema permits" claim
      // above true rather than approximately true (#1939).
      const violation = findHostSecretReadListViolation(readArr as string[]);
      if (violation) {
        fail(
          violation.kind === "maxItems"
            ? "hostSecrets.read"
            : `hostSecrets.read[${violation.index}]`,
          violation.kind === "maxItems"
            ? `has ${violation.count} entries; at most ${HOST_SECRET_READ_MAX_ITEMS} are allowed (manifest_schema)`
            : `value '${violation.key}' is a duplicate; entries must be unique (manifest_schema)`,
          `"hostSecrets": { "read": ["llm.apiKey.openai"] }`,
        );
      }
    }
  }

  // Onboarding highlight identity. The schema bounds the LIST and the shape of
  // each `id`; what it cannot express is that two entries must not carry the
  // SAME id. That is not cosmetic here: `<pluginId>:<id>` is the key the user's
  // answer is stored under, so a duplicate would let one card's "never show
  // this" silence a different card the user never saw. The count is re-checked
  // alongside it for the same reason `hostSecrets` re-checks its own bounds — a
  // plugin using older contract files must not widen what it declares.
  const onboardingRaw: unknown = (parsed as { onboarding?: unknown }).onboarding;
  const highlightsRaw: unknown =
    onboardingRaw && typeof onboardingRaw === "object" && !Array.isArray(onboardingRaw)
      ? (onboardingRaw as { highlights?: unknown }).highlights
      : undefined;
  if (Array.isArray(highlightsRaw)) {
    if (highlightsRaw.length > MAX_PLUGIN_ONBOARDING_HIGHLIGHTS) {
      fail(
        "onboarding.highlights",
        `has ${highlightsRaw.length} entries; at most ${MAX_PLUGIN_ONBOARDING_HIGHLIGHTS} are allowed (manifest_schema)`,
        `"onboarding": { "highlights": [{ "id": "pick-a-folder", "copy": { "en": { "headline": "…", "body": "…", "actionLabel": "…" } }, "action": { "kind": "none" } }] }`,
      );
    }
    const seenHighlightIds = new Set<string>();
    for (let i = 0; i < highlightsRaw.length; i += 1) {
      const id: unknown = (highlightsRaw[i] as { id?: unknown })?.id;
      if (typeof id !== "string") continue;
      if (seenHighlightIds.has(id)) {
        fail(
          `onboarding.highlights[${i}].id`,
          `value '${id}' is a duplicate; highlight ids must be unique within a plugin (manifest_schema)`,
          `"onboarding": { "highlights": [{ "id": "pick-a-folder", … }, { "id": "try-search", … }] }`,
        );
      }
      seenHighlightIds.add(id);

      // Onboarding `settings` destinations. The schema can only say the path
      // is a kebab segment or a pair of them; only the host knows which tabs
      // and sections this build ships. Validating here rather than at accept
      // time is what makes the destination trustworthy: a card whose action
      // points nowhere would render, be answered "yes", and then do nothing.
      const action: unknown = (highlightsRaw[i] as { action?: unknown })?.action;
      const actionPath: unknown =
        action && typeof action === "object" && !Array.isArray(action) &&
        (action as { kind?: unknown }).kind === "settings"
          ? (action as { path?: unknown }).path
          : undefined;
      if (actionPath !== undefined && parseSettingsPath(actionPath) === null) {
        fail(
          `onboarding.highlights[${i}].action.path`,
          `value ${JSON.stringify(actionPath)} does not name a settings page this build ships; use "<tab>" or "<tab>/<section>" (manifest_schema)`,
          `"action": { "kind": "settings", "path": "permissions/permissions-os-sandbox" }`,
        );
      }
    }
  }

  // Plugin↔app minimum-version gate — re-validate the format at host load even
  // though the host schema has the same `pattern` (same rationale as
  // hostSecrets above: a plugin using older contract files must not
  // smuggle a non-SemVer `minAppVersion`). The host enforces compatibility at
  // install + load against this value, so a malformed string would make the
  // `compareSemver` gate fail-closed silently — fail loud here instead.
  const requiresRaw: unknown = (parsed as { requires?: unknown }).requires;
  if (requiresRaw && typeof requiresRaw === "object" && !Array.isArray(requiresRaw)) {
    const minAppVersionRaw: unknown = (requiresRaw as { minAppVersion?: unknown }).minAppVersion;
    if (minAppVersionRaw !== undefined) {
      if (typeof minAppVersionRaw !== "string" || !STABLE_SEMVER_RE.test(minAppVersionRaw)) {
        fail(
          "requires.minAppVersion",
          "must be a stable SemVer string MAJOR.MINOR.PATCH (no range, pre-release, build metadata, or leading zeros) — manifest_schema",
          `"requires": { "minAppVersion": "1.4.0" }`,
        );
      }
    }
    // The host protocol gate reads this value at every load, so a malformed
    // one must fail here, loudly, rather than as an "unserved version" that
    // names a version nobody declared.
    const hostProtocolRaw: unknown = (requiresRaw as { hostProtocol?: unknown }).hostProtocol;
    if (hostProtocolRaw !== undefined) {
      if (typeof hostProtocolRaw !== "string" || !HOST_PROTOCOL_VERSION_RE.test(hostProtocolRaw)) {
        fail(
          "requires.hostProtocol",
          "must be a positive integer written as a string, with no leading zeros — manifest_schema",
          `"requires": { "hostProtocol": "${HOST_PROTOCOL_VERSIONS_SERVED[0]}" }`,
        );
      }
    }
  }

  // The package id `host` is the host's own: host alert kinds stage the
  // source `overlay:host--<kind>`, which a plugin named `host` would mint for
  // its own kinds. The marketplace validators refuse the name too; this
  // covers every other way a manifest reaches the loader.
  if (parsed.id === ALERT_RESERVED_PACKAGE_ID) {
    fail(
      "id",
      `value '${ALERT_RESERVED_PACKAGE_ID}' is reserved for the host`,
      `"name": "meeting-recorder"`,
    );
  }

  // Alert and config-inheritance declarations are read here once so a refused
  // block is reported when the plugin loads, not first at a raise. A refusal
  // does not fail the load: the block grants nothing, as `workProposals`.
  getDeclaredAlertKinds(parsed, pid);
  getDeclaredConfigInherits(parsed, pid);
  documentSha256ByManifest.set(manifest, authoredSha256);
  return manifest;
}
