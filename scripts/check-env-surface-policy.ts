// User configuration must have a reachable Settings control.
// Classify every AVE_* read exactly once and keep pending settings shrink-only.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_DEVELOPMENT_ENV_VARS,
  DEVELOPMENT_ENV_TOMBSTONES,
} from "../src/shared/development-env-policy.js";
import { ENV_BACKED_SETTINGS } from "../src/shared/env-backed-settings.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const RENDERER = join(SRC, "ui", "renderer");

// Scan only AVE variables; the shared development policy also covers other namespaces.
export const DEVELOPMENT: readonly string[] = ACTIVE_DEVELOPMENT_ENV_VARS.filter(
  (name) => name.startsWith("AVE_"),
);

const DEVELOPMENT_TOMBSTONE_SET: ReadonlySet<string> = new Set(DEVELOPMENT_ENV_TOMBSTONES);

// Host-owned child environment, not user configuration.
const INTERNAL: readonly string[] = [
  "AVE_DEV_LAUNCHER",
  // Pass ACL paths as JSON data, never interpolate them into the child command.
  "AVE_DACL_REQUEST",
  // The host selects the journal in the admitted shell's private HOME.
  "AVE_DOCUMENT_JOURNAL",
  // Hook metadata is host-owned; matcher and payload fields are conditional.
  "AVE_HOOK_EVENT",
  "AVE_HOOK_MATCHER",
  "AVE_HOOK_MCP_SERVER_ID",
  "AVE_HOOK_PLUGIN_ID",
  "AVE_HOOK_SESSION_ID",
  "AVE_HOOK_TOOL_NAME",
  "AVE_HOOK_TRUST_ORIGIN",
  "AVE_HOOK_TYPE",
  // Pass the certificate-name needle as data rather than interpolated script text.
  "AVE_CORP_CA_QUERY",
  // Host-owned integrity metadata for the child that protects sandbox directories.
  "AVE_SRT_OWNER_PID",
  "AVE_SRT_OWN_DIRECTORIES",
  "AVE_SRT_PRIVATE_DIRECTORY",
  "AVE_SRT_TEMP_ROOT",
  "AVE_ASRT_ACL_TARGET",
  "AVE_ASRT_ICACLS_PATH",
  "AVE_PROBE_RHS",
  "AVE_PROBE_VALUE",
  // The host chooses the loopback port and token for the subscription bridge.
  "AVE_SUBSCRIPTION_TOOL_BRIDGE_TOKEN",
  "AVE_SUBSCRIPTION_TOOL_BRIDGE_URL",
  // The host mints a single-use ticket and socket for the marketplace credential helper.
  "AVE_ASKPASS_ENDPOINT",
  "AVE_ASKPASS_TICKET",
  // The host assigns this terminal id so child scripts can identify their tab.
  "AVE_TERMINAL_ID",
];

// Pre-launch configuration belongs here only when an in-app control would be wrong.
// Relocating AVE_HOME while running would strand open handles and the active settings store.
const PRE_LAUNCH: readonly string[] = [
  "AVE_HOME",
  // Host paths and the pinned external encryption provider are fixed at startup.
  "AVE_USER_DATA_DIR",
  "AVE_RESOURCES_DIR",
  "AVE_SECRET_KEY_FILE",
  // The launcher selects the trace sink before any window exists; tracing is opt-in.
  "AVE_TELEMETRY",
];

// Deployment-owned bounds must be visible in the UI but cannot be widened there.
// Show the allowed telemetry hosts beside endpoint configuration.
const GUARDRAIL: readonly string[] = [
  "AVE_TELEMETRY_ALLOWLIST",
];

// The tailnet control writes a host-owned file to keep authorization unsettable by the renderer.
const SETTINGS_BACKED: readonly string[] = [
  ...ENV_BACKED_SETTINGS.map((entry) => entry.envVar),
  "AVE_TAILNET_CONTROLLER",
  "AVE_TAILNET_OBSERVER",
  "AVE_TAILNET_OBSERVER_AUTHORIZATION",
  "AVE_TAILNET_OBSERVER_PORT",
  "AVE_TAILNET_PAIRED_SHARING",
  "AVE_TAILNET_WEB",
  "AVE_TAILNET_WEB_ORIGIN",
];

// Pending controls are shrink-only; adding an entry requires an explicit ceiling increase.
const PENDING: readonly string[] = [
];

const PENDING_CEILING = 0;

// Recognize literal environment reads through process.env and passed env parameters.
// Bare AVE_* constants are not evidence of an environment read.
const READ_RE =
  /(?:process\.)?env\s*(?:\.\s*(AVE_[A-Z0-9_]+)|\[\s*["'`](AVE_[A-Z0-9_]+)["'`]\s*\])/g;

// Parse helper calls so comments and example strings cannot satisfy the gate.
function developmentHelperReads(text: string): string[] {
  const variables: string[] = [];
  const helper = "readDevelopmentEnvVar";
  let index = 0;
  const skipQuoted = (quote: string): void => {
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      const current = text[index++];
      if (current === quote) return;
    }
  };

  while (index < text.length) {
    if (text.startsWith("//", index)) {
      const newline = text.indexOf("\n", index + 2);
      index = newline === -1 ? text.length : newline + 1;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    const current = text[index]!;
    if (current === '"' || current === "'" || current === "`") {
      skipQuoted(current);
      continue;
    }
    if (text.startsWith(helper, index)) {
      const before = index === 0 ? "" : text[index - 1]!;
      const after = text[index + helper.length] ?? "";
      if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) {
        let cursor = index + helper.length;
        while (/\s/.test(text[cursor] ?? "")) cursor += 1;
        if (text[cursor] === "(") {
          cursor += 1;
          while (/\s/.test(text[cursor] ?? "")) cursor += 1;
          const quote = text[cursor];
          if (quote === '"' || quote === "'" || quote === "`") {
            const end = text.indexOf(quote, cursor + 1);
            const variable = end === -1 ? "" : text.slice(cursor + 1, end);
            if (/^AVE_[A-Z0-9_]+$/.test(variable)) variables.push(variable);
          }
        }
      }
      index += helper.length;
      continue;
    }
    index += 1;
  }
  return variables;
}

// Dynamic lookups need table-entry scanning; the literal-read pattern cannot see their keys.
const DYNAMIC_LOOKUP_RE = /(?:process\.)?env\s*\[\s*(?!["'`])/;

// Quoted names count only in files with dynamic lookups.
// Exclude test fixtures and trailing-underscore prefixes.
const TABLE_ENTRY_RE = /["'`](AVE_[A-Z0-9_]*[A-Z0-9])["'`]/g;
const TEST_FILE_RE = /(?:(?:^|[\\/])__tests__[\\/])|(?:\.test\.[cm]?tsx?$)/;

// Include host-written child variables and embedded shell reads, excluding tests.
// Distinguish shell reads from template interpolation, type annotations and ternaries.
const CHILD_PROTOCOL_RES: readonly RegExp[] = [
  /\$\{?[Ee][Nn][Vv]:(AVE_[A-Z0-9_]*[A-Z0-9])\b/g,
  /GetEnvironmentVariable\(\s*["'](AVE_[A-Z0-9_]*[A-Z0-9])["']/g,
  /(?<![\w$])\$(AVE_[A-Z0-9_]*[A-Z0-9])\b/g,
  /(?<![\w$.[]|\b(?:const|let|var)\s+|\?\s*)["']?(AVE_[A-Z0-9_]*[A-Z0-9])["']?\s*:(?!:)/g,
  /\[\s*["'`](AVE_[A-Z0-9_]*[A-Z0-9])["'`]\s*\]\s*:(?!:)/g,
];

// Interpolated child reads use quoted AVE_* constants as evidence.
const INTERPOLATED_CHILD_LOOKUP_RE = /(?:GetEnvironmentVariable\(\s*["']?|\$\{?[Ee][Nn][Vv]:)\$\{/;

function scan(dir: string, found: Map<string, string>): void {
  // Directory entries provide type information without a separate stat race.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const path = join(dir, name);
    if (entry.isDirectory()) {
      scan(path, found);
      continue;
    }
    if (!/\.(ts|tsx|mts|cts)$/.test(name)) continue;
    const text = readFileSync(path, "utf-8");
    const where = relative(ROOT, path).replaceAll("\\", "/");
    for (const variable of developmentHelperReads(text)) {
      if (TEST_FILE_RE.test(where) && DEVELOPMENT_TOMBSTONE_SET.has(variable)) continue;
      if (!found.has(variable)) found.set(variable, where);
    }
    const patterns = [READ_RE];
    if (!TEST_FILE_RE.test(where)) {
      patterns.push(...CHILD_PROTOCOL_RES);
      if (DYNAMIC_LOOKUP_RE.test(text) || INTERPOLATED_CHILD_LOOKUP_RE.test(text)) {
        patterns.push(TABLE_ENTRY_RE);
      }
    }
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const variable = match[1] ?? match[2]!;
        if (TEST_FILE_RE.test(where) && DEVELOPMENT_TOMBSTONE_SET.has(variable)) continue;
        if (!found.has(variable)) found.set(variable, where);
      }
    }
  }
}

export function scanEnvReads(root: string = SRC): Map<string, string> {
  const found = new Map<string, string>();
  scan(root, found);
  return found;
}

// A settings path needs a quoted reference in renderer source to prove UI reachability.
// Test fixtures cannot satisfy that requirement.
export function scanRendererSettingsPaths(root: string = RENDERER): Set<string> {
  const paths = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const where = relative(ROOT, path).replaceAll("\\", "/");
      if (TEST_FILE_RE.test(where)) continue;
      for (const match of readFileSync(path, "utf-8").matchAll(SETTINGS_PATH_LITERAL_RE)) {
        paths.add(match[1]!);
      }
    }
  };
  walk(root);
  return paths;
}

const SETTINGS_PATH_LITERAL_RE = /["'`]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)["'`]/g;

export const BUCKETS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["development", DEVELOPMENT],
  ["internal", INTERNAL],
  ["pre-launch", PRE_LAUNCH],
  ["guardrail", GUARDRAIL],
  ["settings", SETTINGS_BACKED],
  ["pending", PENDING],
];

export function evaluate(
  found: ReadonlyMap<string, string>,
  buckets: ReadonlyArray<readonly [string, readonly string[]]> = BUCKETS,
  pending: readonly string[] = PENDING,
  pendingCeiling: number = PENDING_CEILING,
  rendererPaths: ReadonlySet<string> = scanRendererSettingsPaths(),
): readonly string[] {
  const failures: string[] = [];

  // A registry claim without a renderer reference does not prove a reachable control.
  for (const entry of ENV_BACKED_SETTINGS) {
    if (!rendererPaths.has(entry.settingsPath)) {
      failures.push(
        `${entry.settingsPath} (${entry.envVar}): in ENV_BACKED_SETTINGS but no renderer `
        + `file names it, so the "settings" classification claims a control that does not `
        + `exist. Build the control, or move the variable to another bucket.`,
      );
    }
  }

  // Each variable must belong to exactly one bucket.
  const seen = new Map<string, string>();
  for (const [bucket, names] of buckets) {
    for (const name of names) {
      const previous = seen.get(name);
      if (previous !== undefined) {
        failures.push(`${name}: classified as both "${previous}" and "${bucket}"`);
      }
      seen.set(name, bucket);
    }
  }

  for (const [variable, where] of [...found].sort()) {
    if (!seen.has(variable)) {
      failures.push(
        `${variable} (${where}): read by the source and classified nowhere. `
        + `Add it to one bucket in scripts/check-env-surface-policy.ts — and if it `
        + `configures the app for the person using it, build the control instead of `
        + `listing it as pending.`,
      );
    }
  }

  for (const [bucket, names] of buckets) {
    for (const name of names) {
      if (!found.has(name)) {
        failures.push(`${name}: listed under "${bucket}" but nothing reads it any more — drop the entry.`);
      }
    }
  }

  if (pending.length > pendingCeiling) {
    failures.push(
      `pending list grew to ${pending.length} (ceiling ${pendingCeiling}). The ceiling only moves down.`,
    );
  }

  return failures;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = scanEnvReads();
  const failures = evaluate(found);
  if (failures.length > 0) {
    console.error(`[env-surface] ${failures.length} problem(s)`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(
    `[env-surface] OK — ${found.size} variable(s) read: `
    + `${SETTINGS_BACKED.length} with a control, ${PENDING.length} pending (ceiling ${PENDING_CEILING}), `
    + `${DEVELOPMENT.length} development, ${INTERNAL.length} internal, `
    + `${PRE_LAUNCH.length} pre-launch, ${GUARDRAIL.length} guardrail`,
  );
}
