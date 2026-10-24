/**
 * Env-surface policy gate.
 *
 * The rule this enforces: an environment variable that configures the app for
 * the person using it must ALSO be reachable from Settings. A packaged app is
 * launched by double-clicking it — there is no shell to export anything in —
 * so a capability whose only switch is an env var is a capability that user
 * does not have. Several already shipped that way before anyone noticed.
 *
 * The gate cannot decide which variables are user configuration and which are
 * scaffolding, so it does not try. It requires every `AVE_*` variable the
 * source actually READS to be classified here, in exactly one bucket, and it
 * refuses to let the unfinished bucket grow. What it buys is that the next
 * variable of this kind is a decision someone makes on purpose, in a diff, and
 * not a surface that quietly never existed.
 *
 * Buckets:
 *   development — meaningful only running from source, in tests, or in E2E.
 *                 Packaged builds ignore or scrub these (see `dev-flags.ts`).
 *   internal    — part of a host↔child protocol or the packaging layout. The
 *                 app writes it; nobody configures it.
 *   pre-launch  — real user configuration, decided before the app exists to
 *                 ask: at install time, or on the command that starts it.
 *   settings    — has a control the user can reach. Cross-checked below: every
 *                 registry path must be named by a renderer surface, because
 *                 "listed in ENV_BACKED_SETTINGS" is a claim about the UI and
 *                 the registry alone cannot make it true.
 *   pending     — SHOULD have a control and does not yet. Shrink-only.
 *
 * Usage: node --import tsx scripts/check-env-surface-policy.ts
 */
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

/**
 * Only meaningful outside a packaged build. The shared policy also contains
 * non-AVE development variables such as VITE_DEBUG_STREAM; this gate scans
 * and classifies the AVE namespace only.
 */
export const DEVELOPMENT: readonly string[] = ACTIVE_DEVELOPMENT_ENV_VARS.filter(
  (name) => name.startsWith("AVE_"),
);

const DEVELOPMENT_TOMBSTONE_SET: ReadonlySet<string> = new Set(DEVELOPMENT_ENV_TOMBSTONES);

/** The app sets these for something it launched; they are not configuration. */
const INTERNAL: readonly string[] = [
  // The host hands the AVE_HOME paths and the icacls path to its one-shot DACL
  // read-back PowerShell child as one JSON value, so nothing is spliced into
  // -Command (ave-home.ts).
  "AVE_DACL_REQUEST",
  // Lifecycle and script hooks: the host describes the event to the hook
  // process it spawns (buildHookEnv, script-hook-runner.ts). TYPE, EVENT,
  // SESSION_ID and TRUST_ORIGIN are set on every invocation; MATCHER,
  // TOOL_NAME, MCP_SERVER_ID and PLUGIN_ID only when the hook has a matcher or
  // the payload carries that field.
  "AVE_HOOK_EVENT",
  "AVE_HOOK_MATCHER",
  "AVE_HOOK_MCP_SERVER_ID",
  "AVE_HOOK_PLUGIN_ID",
  "AVE_HOOK_SESSION_ID",
  "AVE_HOOK_TOOL_NAME",
  "AVE_HOOK_TRUST_ORIGIN",
  "AVE_HOOK_TYPE",
  // The corporate-CA extraction child's common-name needle, passed as
  // data rather than spliced into its PowerShell script (corp-ca-extract.ts).
  "AVE_CORP_CA_QUERY",
  // The Windows sandbox-runtime integrity children: the owner pid and the
  // directories the host created, handed to the PowerShell script that
  // verifies and protects them (srt-win-integrity.ts).
  "AVE_SRT_OWNER_PID",
  "AVE_SRT_OWN_DIRECTORIES",
  "AVE_SRT_PRIVATE_DIRECTORY",
  "AVE_SRT_TEMP_ROOT",
  // The package root and icacls path for the sandbox ACL child
  // (asrt-windows-support.ts).
  "AVE_ASRT_ACL_TARGET",
  "AVE_ASRT_ICACLS_PATH",
  // The bash capability probe sets and reads these inside its own `-c`
  // script to see how the shell expands assignments (shell-resolver.ts).
  "AVE_PROBE_RHS",
  "AVE_PROBE_VALUE",
  // Both halves of the subscription tool bridge. The host binds an ephemeral
  // loopback port and mints a token, then hands the pair to the MCP child it
  // just spawned; neither is something a person configures. The URL sat in
  // PENDING, which asked for a control over a port number this process chose
  // for itself — and a pending entry is a promise to build a surface, so the
  // list has to mean it.
  "AVE_SUBSCRIPTION_TOOL_BRIDGE_TOKEN",
  "AVE_SUBSCRIPTION_TOOL_BRIDGE_URL",
  // The marketplace's git askpass helper: the host mints a single-use ticket
  // and names its local socket for the git child it spawns (design §9.3).
  "AVE_ASKPASS_ENDPOINT",
  "AVE_ASKPASS_TICKET",
  // The workspace terminal's own tab id, set in each shell's environment so a
  // script run there can name the terminal it runs in (pty-manager.ts). The
  // host chooses it; nobody configures it.
  "AVE_TERMINAL_ID",
];

/**
 * Configuration the user really does choose — but not from inside the running
 * app, because the app cannot ask.
 *
 * `AVE_HOME` names the directory every store, log, cache and sandbox rule is
 * resolved against, and `aveHome()` re-reads it on every call precisely so a
 * relocated home is honored everywhere. A Settings control over it would be a
 * control over where the settings it was just read from live: choosing a new
 * value would strand every open handle, every path already handed to a plugin
 * child, and the profile the control itself writes to. The honest surfaces are
 * the installer (PR #1062 adds exactly that for Windows) and the launch
 * command — both of which run before there is anything to strand.
 *
 * This is not an escape hatch for "we did not build it yet". An entry belongs
 * here only when a control INSIDE the app would be wrong, not merely missing.
 */
const PRE_LAUNCH: readonly string[] = [
  "AVE_HOME",
  // Host paths and the pinned external encryption provider are fixed at startup.
  "AVE_USER_DATA_DIR",
  "AVE_RESOURCES_DIR",
  "AVE_SECRET_KEY_FILE",
  // Names the trace sink for one run — a collector URL or a file path. It is
  // decided by whoever starts the process (a benchmark harness, a support
  // capture), before there is a window to ask in, and it is off unless set.
  "AVE_TELEMETRY",
];

/**
 * Bounds a setting the user can already reach.
 *
 * `AVE_TELEMETRY_ALLOWLIST` is the set of hosts `telemetry.endpoint` may
 * point at, and the endpoint is a field in the Settings UI. A control over the
 * allowlist would therefore be a control the same party could widen to match
 * whatever endpoint they just typed — which is not a bound, it is a second
 * click. The deployment sets it; the app shows it (Audit → Telemetry, testid
 * `telemetry-allowed-hosts`) so the endpoint field is not rejecting hosts for
 * invisible reasons.
 *
 * The obligation is still a surface obligation, just a read-only one: an entry
 * here must be VISIBLE somewhere in the app. "The user cannot change it" is
 * not the same claim as "the user cannot see it", and only the first one
 * belongs in this bucket.
 */
const GUARDRAIL: readonly string[] = [
  "AVE_TELEMETRY_ALLOWLIST",
];

/**
 * Reachable from Settings today.
 *
 * The tailnet group is listed by name rather than through
 * {@link ENV_BACKED_SETTINGS} because its control writes a host-owned file
 * instead of the settings store — the authorization boundary it carries must
 * stay unsettable by a renderer. Same surface obligation, different backing.
 */
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

/**
 * Configuration a user could need, with no way to reach it yet.
 *
 * Shrink-only: {@link PENDING_CEILING} must come DOWN as these get surfaces,
 * and a new entry here fails the gate until the ceiling is deliberately
 * raised in the same diff that adds it. "Pending" is not the answer for a new
 * variable — building the control is.
 */
const PENDING: readonly string[] = [
];

const PENDING_CEILING = 0;

/**
 * `process.env.NAME`, `process.env["NAME"]`, and the same two through a passed
 * `env` parameter — which is how most of the resolvers here take it, so a
 * `process.env`-only scan would miss nearly every gate that matters.
 *
 * Deliberately NOT a bare `AVE_[A-Z_]+` scan: many such names are ordinary
 * TypeScript constants (`AVE_TOKEN_NAMES`, `AVE_LOGO_PATH`), and a gate that
 * demanded those be classified as configuration would be asking for nonsense.
 */
const READ_RE =
  /(?:process\.)?env\s*(?:\.\s*(AVE_[A-Z0-9_]+)|\[\s*["'`](AVE_[A-Z0-9_]+)["'`]\s*\])/g;

/**
 * Literal reads through the packaged-gated helper. Parse calls rather than
 * matching text so a policy comment or example string cannot satisfy the
 * environment-surface gate.
 */
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

/**
 * An env lookup whose key is an expression rather than a literal — `env[KEY[k]]`,
 * `env[name]`. The resolvers that carry the most configuration are written this
 * way (one table of key→variable, one loop), and {@link READ_RE} cannot see a
 * single one of their variables: the names live in the table, not at the lookup.
 * The tailnet group went invisible to this gate the moment its server adopted
 * that shape, which is exactly the direction a policy gate must not fail in.
 */
const DYNAMIC_LOOKUP_RE = /(?:process\.)?env\s*\[\s*(?!["'`])/;

/**
 * In a file that does a dynamic lookup, a quoted variable name IS the read —
 * it is the table entry the lookup resolves through.
 *
 * Two deliberate narrowings, because outside that context a quoted `AVE_*` is
 * usually not a variable at all:
 *   - tests are excluded; a name quoted in a test is a fixture it sets, and the
 *     production read that gives it meaning is already counted where it lives.
 *   - a trailing underscore marks a PREFIX (`AVE_DEMO_`, matched by the
 *     packaged-env scrub), which is a family of variables and not one of them.
 */
const TABLE_ENTRY_RE = /["'`](AVE_[A-Z0-9_]*[A-Z0-9])["'`]/g;
const TEST_FILE_RE = /(?:(?:^|[\\/])__tests__[\\/])|(?:\.test\.[cm]?tsx?$)/;

/**
 * The other half of a host↔child protocol: a variable the host WRITES for a
 * child it spawns, and the child script (embedded here as a string) READS.
 * Neither side is a `process.env` read, so {@link READ_RE} sees neither, and
 * such a variable used to pass this gate unclassified — `AVE_DACL_SYSTEM_ROOT`
 * did, and `AVE_DACL_PATHS` was only "found" because a test happened to read
 * it back from the spawn options. Each shape is one production source here
 * actually uses:
 *   - `$env:NAME` / `${env:NAME}` — a PowerShell child read;
 *   - `[Environment]::GetEnvironmentVariable('NAME', …)` — the same, via .NET;
 *   - `$NAME` — a POSIX shell child read (`${NAME}` is excluded: in TypeScript
 *     that is a template interpolation of a constant, not a shell read);
 *   - `NAME: value` / `["NAME"]: value` — an object key, plain or a quoted
 *     computed key, which is how a spawn's `env` is written. A type
 *     annotation (`const NAME: T`) and a ternary branch are excluded.
 * Tests are excluded for the same reason as {@link TABLE_ENTRY_RE}: a test
 * writes and reads fixtures for children it starts itself.
 */
const CHILD_PROTOCOL_RES: readonly RegExp[] = [
  /\$\{?[Ee][Nn][Vv]:(AVE_[A-Z0-9_]*[A-Z0-9])\b/g,
  /GetEnvironmentVariable\(\s*["'](AVE_[A-Z0-9_]*[A-Z0-9])["']/g,
  /(?<![\w$])\$(AVE_[A-Z0-9_]*[A-Z0-9])\b/g,
  /(?<![\w$.[]|\b(?:const|let|var)\s+|\?\s*)["']?(AVE_[A-Z0-9_]*[A-Z0-9])["']?\s*:(?!:)/g,
  /\[\s*["'`](AVE_[A-Z0-9_]*[A-Z0-9])["'`]\s*\]\s*:(?!:)/g,
];

/**
 * A child read whose name is interpolated from a constant —
 * `GetEnvironmentVariable('${TARGET_ENV}')`, `$env:${NAME}`. As with
 * {@link DYNAMIC_LOOKUP_RE}, the quoted `AVE_*` literal in that file is the read.
 */
const INTERPOLATED_CHILD_LOOKUP_RE = /(?:GetEnvironmentVariable\(\s*["']?|\$\{?[Ee][Nn][Vv]:)\$\{/;

function scan(dir: string, found: Map<string, string>): void {
  // `withFileTypes` rather than a `statSync` beside the read: one syscall
  // answers directory-or-file, so there is no window between the check and
  // the open in which the entry could become something else.
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

/** Every `AVE_*` variable the source reads, mapped to the first file reading it. */
export function scanEnvReads(root: string = SRC): Map<string, string> {
  const found = new Map<string, string>();
  scan(root, found);
  return found;
}

/**
 * Every settings path a renderer file mentions by name.
 *
 * A quoted literal is the evidence, because that is how the surfaces name a
 * path: most tabs write `settingsPath="system.corpCaEnabled"` on the notice,
 * and the one table-driven tab writes `path: "system.localApiServer"` in its
 * row list and passes `settingsPath={row.path}`. Both spellings are a quoted
 * literal in a renderer file, and a path named nowhere in the renderer cannot
 * have a control regardless of what the registry says about it.
 *
 * Tests are excluded on purpose: a path quoted in a test is a fixture, and
 * accepting it would let the gate be satisfied by a test for a control that
 * does not exist.
 */
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

/** A dotted settings path in quotes — `"system.corpCaEnabled"`. */
const SETTINGS_PATH_LITERAL_RE = /["'`]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)["'`]/g;

export const BUCKETS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["development", DEVELOPMENT],
  ["internal", INTERNAL],
  ["pre-launch", PRE_LAUNCH],
  ["guardrail", GUARDRAIL],
  ["settings", SETTINGS_BACKED],
  ["pending", PENDING],
];

/**
 * The whole policy, as a pure function of what was found and what was declared
 * — so the gate's own failure modes can be exercised without a repository that
 * violates them. A gate nobody has ever seen fail is a gate nobody knows works.
 */
export function evaluate(
  found: ReadonlyMap<string, string>,
  buckets: ReadonlyArray<readonly [string, readonly string[]]> = BUCKETS,
  pending: readonly string[] = PENDING,
  pendingCeiling: number = PENDING_CEILING,
  rendererPaths: ReadonlySet<string> = scanRendererSettingsPaths(),
): readonly string[] {
  const failures: string[] = [];

  // A registry entry is a claim that the setting is reachable, and the registry
  // is what puts its variable in the "settings" bucket above. If no renderer
  // file so much as names the path, the claim is false and the gate is
  // certifying a surface that was never built — the exact shape of the problem
  // this file exists to catch.
  for (const entry of ENV_BACKED_SETTINGS) {
    if (!rendererPaths.has(entry.settingsPath)) {
      failures.push(
        `${entry.settingsPath} (${entry.envVar}): in ENV_BACKED_SETTINGS but no renderer `
        + `file names it, so the "settings" classification claims a control that does not `
        + `exist. Build the control, or move the variable to another bucket.`,
      );
    }
  }

  // Classified in more than one bucket: the two claims contradict each other,
  // and whichever the reader believes is a coin flip.
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

/** Direct invocation runs the real scan; importing the module does not. */
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
