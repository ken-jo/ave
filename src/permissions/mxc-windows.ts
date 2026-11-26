// Each shell command gets its own container, filesystem policy and kernel-bound proxy listener; deny/read-only entries outrank write grants, but missing read-only targets do not protect future paths. Killing the launcher tears down descendants, and containers cannot terminate host processes (docs/architecture/architecture.md).
// Use the signed CLI to relay stdio/exit while the embedded runtime lacks required native support. Plugin workers retain their separate sandbox because proxy mode forbids direct loopback control; terminals remain user-owned and need background descendants to survive.
import { win32 as winPath } from "node:path";
import { t } from "../i18n/index.js";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";
import { WIN32_POWERSHELL_STARTUP_ARGS } from "../shared/powershell-startup-policy.js";
import { WINDOWS_COMMAND_LINE_LIMIT, WINDOWS_COMMAND_LINE_MARGIN, windowsCommandLineLength } from "../shared/windows-command-line.js";
import { sessionStorePath } from "../shared/session-store-path.js";
import { admitLocalPath, admitLocalRoute, localFs, withLocalityDecision } from "../shared/local-path-io.js";
import { expandWindowsEnvRefs, stripExtendedPathPrefix } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { openMxcPolicyPipe } from "./mxc-policy-pipe.js";
import { isPolicyFloorRow, userDenyCoversPierce, type PolicyModel, type PolicyRow } from "./policy-model.js";
import {
  admitObligations, consumeObligations, obligationWithin, requireEnforceable,
  type AdmittedObligation, type ObligationRow, type ObligationSet,
} from "./admitted-obligation.js";

import { errorMessage } from "../shared/error-message.js";
import { compileGlobMatcher, globToRegExp } from "../lib/glob-matcher.js";
import { isPlainWindowsPathComponent } from "./windows-stamp-targets.js";
import type { SandboxMxcUnavailableReason } from "../shared/sandbox-capability-info.js";
import MXC_PINS from "./mxc-launcher-pins.json" with { type: "json" };

// The stable MXC configuration schema version every request is written in. The launcher is `@microsoft/mxc-sdk` 1.1.0's, pinned by scripts/fetch-mxc.mjs.
const MXC_CONFIG_SCHEMA_VERSION = "1.0.0";

// Why MXC cannot carry agent shells on this host. Stable codes, shown in Settings.
type MxcUnavailableReason = SandboxMxcUnavailableReason;

export type MxcSupport =
  | { readonly state: "available"; readonly windowsBuild: string | null }
  | {
      readonly state: "unavailable";
      readonly reason: MxcUnavailableReason;
      readonly windowsBuild: string | null;
      // Main-process diagnostic; may hold local paths, never sent to the renderer.
      readonly detail: string;
      // The probe's host fact, set only with "container-unavailable".
      readonly baseContainerApiPresent?: boolean;
    };

// The architectures MXC ships `wxc-exec.exe` for.
const MXC_ARCHES = new Set(["x64", "arm64"]);

// The pinned sha256 of the launcher for `arch` (`mxc-launcher-pins.json`, the same file scripts/fetch-mxc.mjs stages against), or undefined for an arch MXC does not ship.
export function pinnedWxcExecSha256(arch: string): string | undefined {
  const pins: Readonly<Record<string, string>> = MXC_PINS.wxcExecSha256;
  return MXC_ARCHES.has(arch) ? pins[arch] : undefined;
}

// `<resources>/mxc/<arch>/wxc-exec.exe`, or undefined for an arch MXC does not ship.
export function wxcExecPathFor(resourcePath: string, arch: string): string | undefined {
  if (!MXC_ARCHES.has(arch)) return undefined;
  return winPath.join(resourcePath, "mxc", arch, "wxc-exec.exe");
}

// The fields of `wxc-exec --probe` Ave reads.
export interface MxcProbeReport {
  readonly tier: string | undefined;
  readonly needsDaclAugmentation: boolean | undefined;
  // Given instead of a tier when the backend cannot serve the request, beside the host facts.
  readonly error: string | undefined;
  readonly baseContainerApiPresent: boolean | undefined;
}

// Parse `wxc-exec --probe` stdout (one JSON object), or undefined when it is not one.
export function parseMxcProbeOutput(stdout: string): MxcProbeReport | undefined {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as { tier?: unknown; needsDaclAugmentation?: unknown; error?: unknown; probes?: unknown };
  const apiPresent = typeof record.probes === "object" && record.probes !== null
    ? (record.probes as { baseContainerApiPresent?: unknown }).baseContainerApiPresent : undefined;
  return {
    tier: typeof record.tier === "string" ? record.tier : undefined,
    needsDaclAugmentation: typeof record.needsDaclAugmentation === "boolean" ? record.needsDaclAugmentation : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    baseContainerApiPresent: typeof apiPresent === "boolean" ? apiPresent : undefined,
  };
}

export type MxcDryRunResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

const MXC_CONTAINER_TIER = "base-container";

function outputLines(stdout: string, stderr: string): string[] {
  return `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function configurationParseError(lines: readonly string[]): string | undefined {
  return lines.find((line) => /^configuration parse error/i.test(line));
}

// Judge `wxc-exec --dry-run`: the request must validate AND `--probe` of the same request must have served it (`probedTier`). The dry run prints no tier; a tier line naming anything else is refused, defensively. Network-policy and PSEC checks happen at launch, so the start probe is what refuses a proxy contract the host cannot carry. A parse error (such as an identity-less proxy the host's PSEC contract cannot carry) is a rejection too; its first diagnostic line is kept for the log.
export function parseMxcDryRunOutput(exitCode: number | null, stdout: string, stderr: string, probedTier: string | undefined): MxcDryRunResult {
  const lines = outputLines(stdout, stderr);
  const otherTier = lines.find((line) => /selected isolation tier/i.test(line) && !/selected isolation tier: base-container$/i.test(line));
  const validated = exitCode === 0 && lines.some((line) => /validation passed/i.test(line));
  if (validated && otherTier === undefined && probedTier === MXC_CONTAINER_TIER) return { ok: true };
  const diagnostic =
    configurationParseError(lines) ??
    lines.find((line) => /"message"\s*:/.test(line)) ??
    otherTier ??
    (validated ? `probed isolation tier: ${probedTier ?? "not reported"}` : undefined) ??
    lines.find((line) => /error/i.test(line) && !/^warning:/i.test(line)) ??
    `exit ${String(exitCode)}`;
  return { ok: false, detail: diagnostic.slice(0, 500) };
}

export interface MxcRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DetectMxcSupportDeps {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  // The app's resource root (`getHostResources.resourcePath`).
  readonly resourcePath: string;
  // `os.release` (`major.minor.build`), for the Settings reason only; never the gate.
  readonly windowsBuild: string | null;
  readonly exists: (path: string) => boolean;
  // Hex sha256 of a file's contents.
  readonly sha256: (path: string) => Promise<string>;
  // Run the launcher with its own directory as the working directory.
  readonly run: (file: string, args: readonly string[], timeoutMs: number) => Promise<MxcRunResult>;
  // An empty directory the probe containers may write (their cwd and LOCALAPPDATA).
  readonly probeDirectory: string;
  // `%SystemRoot%` of the host, for the PowerShell start probe.
  readonly systemRoot: string;
}

const MXC_PROBE_TIMEOUT_MS = 20_000;
// A cold Windows PowerShell start inside a fresh container.
const MXC_START_PROBE_TIMEOUT_MS = 60_000;

// Judge the PowerShell 5.1 start probe: exit 0 is a start. A UI-subsystem initialization failure (`STATUS_DLL_INIT_FAILED`, 0xC0000142) is what a non-interactive session produces (measured over SSH), so it is reported as unverified rather than as a host that cannot run PowerShell.
export function classifyMxcStartProbe(
  code: number | null,
  stdout: string,
  stderr: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: "powershell-start-failed" | "unverified-session"; readonly detail: string } {
  if (code === 0) return { ok: true };
  const text = `${stdout}\n${stderr}`;
  const detail = (text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? `exit ${String(code)}`).slice(0, 500);
  // 0xC0000142 as the unsigned exit code, or the launcher's own diagnostic.
  if (code === 0xc0000142 || /STATUS_DLL_INIT_FAILED|0xC0000142/i.test(text)) {
    return { ok: false, reason: "unverified-session", detail };
  }
  return { ok: false, reason: "powershell-start-failed", detail };
}

// Decide, once at boot, whether agent shells can run in MXC on this host. The OS build number is not the gate: MXC no longer requires PSEC 1.1 for an identity-less loopback proxy (the launcher queries host support, and the directions depend on the Windows build), so a build floor would not establish that the host can carry the request. The gate is what the shipped binary reports: its sha256 must match the pin, `--probe` of the request shape Ave launches (proxy mode, DACL fallback refused) must serve it (the container tier, no DACL changes; an unserved request has no tier and an error), `--dry-run` of that request must validate, and System32 Windows PowerShell 5.1 must actually start (`exit 0`) in a real container of that shape with the loopback proxy; that launch carries the network-policy and PSEC checks the probe does not make. Any failure leaves the shells on the approved-host route.
export async function detectMxcSupport(deps: DetectMxcSupportDeps): Promise<MxcSupport> {
  const prerequisites = await detectMxcPrerequisites(deps);
  if (prerequisites.state === "unavailable") return prerequisites;
  return await probeMxcPowerShellStart(deps);
}

// The fast half of detectMxcSupport, run on the boot path: platform, arch, launcher present and pinned, `--probe` serves the request, `--dry-run` of the shipped request shape. "available" here means only that the start probe is worth running; MXC is not claimed until probeMxcPowerShellStart passes.
export async function detectMxcPrerequisites(deps: DetectMxcSupportDeps): Promise<MxcSupport> {
  const unavailable = (reason: MxcUnavailableReason, detail: string): MxcSupport => ({
    state: "unavailable",
    reason,
    windowsBuild: deps.windowsBuild,
    detail,
  });
  if (deps.platform !== "win32") return unavailable("not-windows", `platform ${deps.platform}`);
  const wxcExec = wxcExecPathFor(deps.resourcePath, deps.arch);
  if (wxcExec === undefined) return unavailable("unsupported-arch", `arch ${deps.arch}`);
  if (!deps.exists(wxcExec)) return unavailable("binary-missing", wxcExec);
  let digest: string;
  try {
    digest = await deps.sha256(wxcExec);
  } catch (error) {
    return unavailable("probe-failed", errorMessage(error));
  }
  if (digest !== pinnedWxcExecSha256(deps.arch)) return unavailable("launcher-mismatch", `${wxcExec} sha256 ${digest}`);

  const request = buildMxcShellRequest({
    commandLine: "cmd.exe /d /c exit 0",
    cwd: deps.probeDirectory,
    grants: { readwrite: [deps.probeDirectory], readonly: [], denied: [] },
    env: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: deps.probeDirectory },
    proxyUrl: "http://127.0.0.1:9",
    timeoutMs: 1_000,
  });
  let probe: MxcRunResult;
  try {
    probe = await deps.run(wxcExec, ["--probe", ...mxcRequestArgs(request, wxcExec, ["--probe"])], MXC_PROBE_TIMEOUT_MS);
  } catch (error) {
    return unavailable("probe-failed", errorMessage(error));
  }
  const report = parseMxcProbeOutput(probe.stdout);
  if (report === undefined) {
    const rejected = configurationParseError(outputLines(probe.stdout, probe.stderr));
    return rejected === undefined
      ? unavailable("probe-failed", `--probe exit ${String(probe.code)}`)
      : unavailable("request-rejected", rejected.slice(0, 500));
  }
  // The probe either serves the request (the container tier, no DACL changes) or omits the tier and gives an error with the host facts. Anything else is not an answer.
  if (report.tier === undefined && report.error !== undefined) {
    return {
      ...unavailable("container-unavailable", `${report.error.slice(0, 400)} (container API ${String(report.baseContainerApiPresent)})`),
      ...(report.baseContainerApiPresent === undefined ? {} : { baseContainerApiPresent: report.baseContainerApiPresent }),
    };
  }
  if (report.tier !== MXC_CONTAINER_TIER || report.needsDaclAugmentation !== false) {
    return unavailable("probe-failed", `unexpected probe answer: tier ${String(report.tier).slice(0, 100)}, needsDaclAugmentation ${String(report.needsDaclAugmentation)}`);
  }
  if (probe.code !== 0) return unavailable("probe-failed", `--probe exit ${String(probe.code)}`);

  let dryRun: MxcRunResult;
  try {
    dryRun = await deps.run(wxcExec, ["--dry-run", ...mxcRequestArgs(request, wxcExec, ["--dry-run"])], MXC_PROBE_TIMEOUT_MS);
  } catch (error) {
    return unavailable("probe-failed", errorMessage(error));
  }
  const verdict = parseMxcDryRunOutput(dryRun.code, dryRun.stdout, dryRun.stderr, report.tier);
  if (!verdict.ok) return unavailable("request-rejected", verdict.detail);
  return { state: "available", windowsBuild: deps.windowsBuild };
}

// The slow half of detectMxcSupport (a cold container start; up to a minute): run after detectMxcPrerequisites passed, off the boot path.
export async function probeMxcPowerShellStart(deps: DetectMxcSupportDeps): Promise<MxcSupport> {
  const unavailable = (reason: MxcUnavailableReason, detail: string): MxcSupport => ({
    state: "unavailable",
    reason,
    windowsBuild: deps.windowsBuild,
    detail,
  });
  const wxcExec = wxcExecPathFor(deps.resourcePath, deps.arch);
  if (wxcExec === undefined) return unavailable("unsupported-arch", `arch ${deps.arch}`);
  // A dry run proves the request is accepted, not that the shell starts. Start the real thing once: System32 Windows PowerShell 5.1 in a container of the shape every command gets (caller-owned reduced environment, proxy mode).
  const startRequest = buildMxcShellRequest({
    commandLine: powerShellMxcCommandLine(deps.systemRoot, "exit 0"),
    cwd: deps.probeDirectory,
    grants: { readwrite: [deps.probeDirectory], readonly: [], denied: [] },
    env: {
      SYSTEMROOT: deps.systemRoot,
      LOCALAPPDATA: deps.probeDirectory,
      TEMP: deps.probeDirectory,
      TMP: deps.probeDirectory,
      PATH: `${win32SystemBinary("", { SystemRoot: deps.systemRoot })};${deps.systemRoot}`,
    },
    // Nothing listens there: the probe makes no network call.
    proxyUrl: "http://127.0.0.1:9",
    timeoutMs: MXC_START_PROBE_TIMEOUT_MS,
  });
  let started: MxcRunResult;
  try {
    started = await deps.run(wxcExec, mxcRequestArgs(startRequest, wxcExec), MXC_START_PROBE_TIMEOUT_MS + 5_000);
  } catch (error) {
    return unavailable("powershell-start-failed", errorMessage(error));
  }
  const start = classifyMxcStartProbe(started.code, started.stdout, started.stderr);
  if (!start.ok) return unavailable(start.reason, start.detail);
  return { state: "available", windowsBuild: deps.windowsBuild };
}

// The filesystem lists of one MXC launch, already ranked.
export interface MxcFilesystemGrants {
  readonly readwrite: readonly string[];
  readonly readonly: readonly string[];
  readonly denied: readonly string[];
  // Protected write denies whose parent is missing: nothing is created or denied, the name is checked after the run.
  readonly watched?: readonly MxcWatchedRow[];
}

/** An absent protected name with the deepest existing folder above it, as admitted for this launch. */
export interface MxcWatchedRow {
  readonly path: string;
  readonly anchor: string;
  readonly volumeSerial: string;
  readonly fileId: string;
}

/** The spelling ranker's result: it admits nothing, so its watched rows carry no identity and no launch accepts them. */
export type MxcSpelledGrants = Omit<MxcFilesystemGrants, "watched"> & { readonly watched?: readonly string[] };

function foldPath(path: string): string {
  const normalized = winPath.normalize(path).replace(/[\\/]+$/, "");
  return (normalized.endsWith(":") ? `${normalized}\\` : normalized).toLowerCase();
}

// True when `child` is `parent` or lies beneath it (Windows, case-insensitive).
export function isWindowsPathAtOrUnder(child: string, parent: string): boolean {
  const c = foldPath(child);
  const p = foldPath(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith("\\") ? p : `${p}\\`);
}

export function strictlyUnder(child: string, parent: string): boolean {
  return foldPath(child) !== foldPath(parent) && isWindowsPathAtOrUnder(child, parent);
}

// A floor row names a directory with a trailing separator; MXC then opens the path as one and refuses a file there (ERROR_DIRECTORY).
function withoutTrailingSeparator(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.length === 0 || trimmed.endsWith(":") ? path : trimmed;
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = foldPath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(winPath.normalize(path));
  }
  return out;
}

export interface MxcDirectoryEntry {
  readonly name: string;
  // "reparse-directory": a directory behind a reparse point that is not a link (a cloud placeholder such as OneDrive Files On-Demand). Its contents
  // cannot be walked, yet the shell can read them, so it is denied as a whole. A "link" (symlink or junction) is not descended.
  readonly kind: "file" | "directory" | "link" | "reparse-directory";
}

interface MxcRule {
  readonly path: string;
  readonly kind: "readwrite" | "readonly" | "deny";
}

const PATTERN_SEGMENT = /[*?]/;
const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|[\\/]{2})/i;
// Bounds the one walk all pattern denies share per spawn; past it the spawn fails closed.
const MXC_PATTERN_WALK_LIMIT = 20_000;

function patternDenyRefusal(pattern: string, reason: string): Error {
  return new Error(`Windows sandbox policy cannot hold pattern deny: ${pattern} (${reason})`);
}

// The one spelling a pattern's walk prefix and matcher both use: drive-absolute with an upper-case drive, or relative; one separator;
// `.` dropped; `..` resolved only before the first wildcard. Components Win32 would open under another name are refused.
function normalizedPatternSpelling(pattern: string): string {
  const refuse = () => patternDenyRefusal(pattern, "cannot normalize the spelling");
  const path = stripExtendedPathPrefix(pattern);
  const drive = /^[a-z]:[\\/]/i.test(path);
  if (!drive && /^[\\/]|:/.test(path)) throw refuse();
  const components: string[] = [];
  let wildcard = false;
  for (const component of path.slice(drive ? 3 : 0).split(/[\\/]+/)) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (wildcard || components.length === 0) throw refuse();
      components.pop();
      continue;
    }
    // `~` and digits may be a short name; that is judged against the directory listings (shortNameRefusal).
    if (!isPlainWindowsPathComponent(component.replace(/[*?%~]/g, "_"))) throw refuse();
    wildcard ||= PATTERN_SEGMENT.test(component);
    components.push(component);
  }
  if (components.length === 0) throw refuse();
  const body = components.join("\\") + (/[\\/]$/.test(path) ? "\\" : "");
  return drive ? `${path.slice(0, 1).toUpperCase()}:\\${body}` : body;
}

interface CompiledPatternDeny {
  readonly pattern: string;
  readonly matches: (path: string) => boolean;
}

// Every pattern's last segment must match an entry's name, so a name lookup narrows the full matches an entry needs to a handful.
function patternMatcher(patterns: readonly CompiledPatternDeny[]): (path: string, name: string) => boolean {
  const byName = new Map<string, CompiledPatternDeny[]>();
  const bySegment: Array<{ readonly segment: RegExp; readonly pattern: CompiledPatternDeny }> = [];
  const always: CompiledPatternDeny[] = [];
  for (const compiled of patterns) {
    const last = compiled.pattern.replaceAll("\\", "/").split("/").at(-1) ?? "";
    if (last === "" || last.includes("**")) always.push(compiled);
    else if (PATTERN_SEGMENT.test(last) || !/^[\x20-\x7e]*$/.test(last)) bySegment.push({ segment: globToRegExp(last, { caseInsensitive: true }), pattern: compiled });
    else {
      const key = last.toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), compiled]);
    }
  }
  const test = ({ matches }: CompiledPatternDeny, path: string): boolean => {
    const slashed = path.replaceAll("\\", "/");
    return matches(slashed) || matches(`${slashed}/`);
  };
  return (path, name) => {
    for (const compiled of always) if (test(compiled, path)) return true;
    for (const compiled of byName.get(name.toLowerCase()) ?? []) if (test(compiled, path)) return true;
    for (const { segment, pattern } of bySegment) if (segment.test(name) && test(pattern, path)) return true;
    return false;
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

interface SpelledPatternDeny {
  readonly requested: string;
  readonly pattern: string;
}

// Where a pattern row ended: walked (every existing match beneath a grant it reaches is returned) or outside every grant.
type PatternOutcome = "walked" | "outside-reach";

// An 8.3 short name opens its object but is never listed, so no walk or match can see what it names.
function shortNameRefusal(pattern: string, name: string): Error {
  return patternDenyRefusal(pattern, `${name} is an 8.3 short name`);
}

function literalPatternPrefix(pattern: string): string {
  const segments = pattern.split("\\");
  const literal = segments.slice(0, segments.findIndex((segment) => PATTERN_SEGMENT.test(segment)));
  return literal.join("\\") + (literal.length === 1 ? "\\" : "");
}

// Native rules are literal paths. The admitted launch policy denies existing pattern matches, including in writable grants.
// A new match is covered at the next launch. Unanchored patterns cover every granted root, and all patterns share one walk cap.
function expandPatternDenies(
  patterns: readonly SpelledPatternDeny[],
  rules: readonly MxcRule[],
  exists: (path: string) => boolean,
  list: ((directory: string) => Iterable<MxcDirectoryEntry>) | undefined,
  allowWritableMatches = false,
  // Whether a lookup of the path opens an object; a `~digit` name it opens that no listing holds is a short name.
  named?: (path: string) => boolean,
): { readonly matches: string[]; readonly outcomes: ReadonlyMap<string, PatternOutcome> } {
  const grants = rules.filter((rule) => rule.kind !== "deny");
  const compiled: CompiledPatternDeny[] = [];
  const outcomes = new Map<string, PatternOutcome>();
  const walkRoots = new Map<string, { readonly root: string; readonly pattern: string }>();
  const addRoot = (root: string, pattern: string): void => {
    let present: boolean;
    try { present = exists(root); }
    catch (error) { throw patternDenyRefusal(pattern, errorMessage(error)); }
    if (present && !walkRoots.has(foldPath(root))) walkRoots.set(foldPath(root), { root, pattern });
  };
  for (const { requested, pattern } of patterns) {
    const glob = pattern.replaceAll("\\", "/");
    if (!WINDOWS_ABSOLUTE.test(pattern)) {
      if (grants.length === 0) { outcomes.set(requested, "outside-reach"); continue; }
      if (!allowWritableMatches && grants.some((rule) => rule.kind === "readwrite")) throw patternDenyRefusal(requested, "an unanchored pattern reaches a writable grant");
      if (list === undefined) throw patternDenyRefusal(requested, "no directory lister");
      compiled.push({ pattern, matches: compileGlobMatcher(glob.startsWith("**") ? glob : `**/${glob}`, { caseInsensitive: true }) });
      for (const rule of grants) addRoot(rule.path, requested);
      outcomes.set(requested, "walked");
      continue;
    }
    const prefix = literalPatternPrefix(pattern);
    const reached = grants.filter((rule) => isWindowsPathAtOrUnder(rule.path, prefix) || isWindowsPathAtOrUnder(prefix, rule.path));
    if (reached.length === 0) { outcomes.set(requested, "outside-reach"); continue; }
    // The most specific rule at or above the pattern's literal prefix decides what the shell may do there.
    const nearest = rules.filter((rule) => isWindowsPathAtOrUnder(prefix, rule.path))
      .sort((a, b) => foldPath(b.path).length - foldPath(a.path).length)[0];
    if (!allowWritableMatches && (nearest?.kind === "readwrite" || reached.some((rule) => rule.kind === "readwrite" && isWindowsPathAtOrUnder(rule.path, prefix)))) {
      throw patternDenyRefusal(requested, "the shell can write where it matches");
    }
    if (list === undefined) throw patternDenyRefusal(requested, "no directory lister");
    compiled.push({ pattern, matches: compileGlobMatcher(glob, { caseInsensitive: true }) });
    // Every grant inside the prefix is its own root: the walk from the prefix does not pass links, and a grant can sit behind one.
    for (const root of [...(nearest?.kind === "readonly" || (allowWritableMatches && nearest?.kind === "readwrite") ? [prefix] : []),
      ...reached.filter((rule) => strictlyUnder(rule.path, prefix)).map((rule) => rule.path)]) {
      addRoot(root, requested);
    }
    outcomes.set(requested, "walked");
  }
  if (compiled.length === 0 || list === undefined) return { matches: [], outcomes };
  const matched = patternMatcher(compiled);
  const out: string[] = [];
  // Roots may nest; a directory one walk already listed is not listed again, so nested roots cost nothing extra.
  const listed = new Set<string>();
  // Literal `~digit` components the walk compares with listed names: unanchored ones, and those after an anchored pattern's first wildcard.
  const shortNameCandidates = patterns.flatMap(({ requested, pattern }) => {
    const segments = pattern.split("\\");
    const first = WINDOWS_ABSOLUTE.test(pattern) ? segments.findIndex((segment) => PATTERN_SEGMENT.test(segment)) : 0;
    return segments.slice(first).filter((segment) => !PATTERN_SEGMENT.test(segment) && /~\d/.test(segment)).map((name) => ({ name, requested }));
  });
  let visited = 0;
  for (const { root, pattern } of walkRoots.values()) {
    const pending = [root];
    if (matched(root, winPath.basename(root))) { out.push(root); continue; }
    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      if (listed.has(foldPath(directory))) continue;
      listed.add(foldPath(directory));
      const names = new Set<string>();
      try {
        for (const entry of list(directory)) {
          if (++visited > MXC_PATTERN_WALK_LIMIT) break;
          names.add(entry.name.toLowerCase());
          const path = `${directory}${directory.endsWith("\\") ? "" : "\\"}${entry.name}`;
          if (entry.kind === "reparse-directory" || matched(path, entry.name)) out.push(path);
          else if (entry.kind === "directory") pending.push(path);
        }
      }
      catch (error) {
        // Removed since its parent was listed: nothing is left to deny.
        if (errorCode(error) === "ENOENT") continue;
        throw patternDenyRefusal(pattern, `cannot list ${directory} under ${root}: ${errorMessage(error)}`);
      }
      if (visited > MXC_PATTERN_WALK_LIMIT) throw patternDenyRefusal(pattern, `more than ${MXC_PATTERN_WALK_LIMIT} entries to check under ${root}`);
      for (const { name, requested } of shortNameCandidates) {
        if (!names.has(name.toLowerCase()) && named?.(winPath.join(directory, name)) === true) throw shortNameRefusal(requested, name);
      }
    }
  }
  return { matches: dedupe(out).sort(), outcomes };
}

// The row classes the ranking below reads, each in the order its rows were stated.
export interface MxcPolicyRows {
  // Write and read grants.
  readonly writeGrants: readonly string[];
  readonly readGrants: readonly string[];
  // Read denies a more specific grant re-opens (the Ave home boundary, sandbox private directories, a composer's own list).
  readonly readDenies: readonly string[];
  // The write floor.
  readonly writeFloor: readonly string[];
  readonly requiredWriteDenies: readonly string[];
  // The protected read floor (`secrets` rows). A grant at or beneath one is dropped.
  readonly protectedFloor: readonly string[];
  // Host-minted pierces. A grant at or beneath one is not dropped by the floor.
  readonly floorPierces: readonly string[];
  // The user's read denies (`user-deny` rows). A grant at or beneath one is dropped, and no pierce covers it.
  readonly userDenies: readonly string[];
}

function pathAndAncestors(path: string): string[] {
  const paths: string[] = [];
  for (let current = withoutTrailingSeparator(path); ; current = winPath.dirname(current)) {
    paths.push(current);
    if (winPath.dirname(current) === current) return paths;
  }
}

// Whether a user's normalized read deny pattern names `target`, its contents or an ancestor; a relative pattern matches at any depth.
function userPatternCovers(pattern: string, target: string): boolean {
  const glob = pattern.replaceAll("\\", "/");
  const matches = compileGlobMatcher(WINDOWS_ABSOLUTE.test(pattern) || glob.startsWith("**") ? glob : `**/${glob}`, { caseInsensitive: true });
  // With a trailing separator a path names its contents too, so `<dir>\**` covers the directory itself.
  return pathAndAncestors(target).some(path => [path, `${path}/`].some(form => matches(form.replaceAll("\\", "/"))));
}

export function mxcPolicyRows(model: PolicyModel): MxcPolicyRows {
  const paths = (keep: (row: PolicyRow) => boolean): string[] => model.rows.filter(keep).map((row) => row.path);
  const grant = (row: PolicyRow): boolean => !isPolicyFloorRow(row) && row.reason !== "floor-pierce";
  return {
    writeGrants: paths((row) => grant(row) && row.access === "rw"),
    readGrants: paths((row) => grant(row) && row.access === "ro"),
    readDenies: paths((row) => isPolicyFloorRow(row) && row.access === "denied" && row.reason !== "secrets" && row.reason !== "user-deny"),
    writeFloor: paths((row) => isPolicyFloorRow(row) && row.access === "ro"),
    requiredWriteDenies: paths((row) => row.reason === "required-write-deny"),
    protectedFloor: paths((row) => row.reason === "secrets"),
    floorPierces: paths((row) => row.reason === "floor-pierce"),
    userDenies: paths((row) => row.reason === "user-deny"),
  };
}

// The same ranking over row spellings and caller-supplied lookups, with no admission. No launch uses it; its tests pin the ranking
// and the pattern walk on simulated layouts.
// Drop grants piercing protected floors except explicit history read exceptions; write denies downgrade grants to read-only. Missing write-deny targets must stay denied because read-only does not prevent creation. Preserve nested read denies, omit redundant denied ancestors, and drop nonexistent grants.
export function rankMxcRowsBySpelling(
  model: PolicyModel,
  exists: (path: string) => boolean,
  list?: (directory: string) => readonly MxcDirectoryEntry[],
): MxcSpelledGrants {
  const rows = mxcPolicyRows(model);
  // POSIX-rooted floor rows must not turn into current-drive paths.
  const windowsPaths = (paths: readonly string[]): readonly string[] => paths.filter((path) => !/^\/(?!\/)/.test(path));
  const protectedFloor = windowsPaths(rows.protectedFloor);
  const denyWrite = windowsPaths(rows.writeFloor);
  const requiredWriteDenies = new Set(rows.requiredWriteDenies.map(foldPath));
  const pierces = rows.floorPierces;
  const userDenies = windowsPaths(rows.userDenies);
  // A relative row is unanchored, as a pattern is: it applies wherever the shell reads, so it is expanded rather than dropped.
  const isPatternDeny = (deny: string): boolean => PATTERN_SEGMENT.test(deny) || !WINDOWS_ABSOLUTE.test(deny);
  for (const pierce of pierces) {
    const rule = userDenies.find((deny) => isPatternDeny(deny)
      ? userPatternCovers(normalizedPatternSpelling(deny), pierce) : isWindowsPathAtOrUnder(pierce, deny));
    if (rule !== undefined) throw userDenyCoversPierce(rule, pierce);
  }
  const floored = (path: string): boolean =>
    userDenies.some((deny) => !isPatternDeny(deny) && isWindowsPathAtOrUnder(path, deny)) ||
    (protectedFloor.some((floor) => isWindowsPathAtOrUnder(path, floor)) &&
    !pierces.some((pierce) => isWindowsPathAtOrUnder(path, pierce)));
  const writeDenied = (path: string): boolean => denyWrite.some((deny) => isWindowsPathAtOrUnder(path, deny));

  const writeGrants = dedupe(rows.writeGrants).filter((path) => exists(path) && !floored(path));
  const readwrite = writeGrants.filter((path) => !writeDenied(path));
  const demoted = writeGrants.filter((path) => writeDenied(path));
  const readGrants = dedupe(rows.readGrants).filter((path) => exists(path) && !floored(path));

  // A pierced floor row is the read exception itself; kept, it would deny the pierced grant as soon as a wider grant contains it. Only the
  // exact row goes: a floor row above a pierce stays, and the more specific read grant carves the pierce out of it.
  const pierced = new Set(pierces.map(foldPath));
  const readDenies = dedupe([...windowsPaths(rows.readDenies), ...protectedFloor.filter((row) => !pierced.has(foldPath(row))), ...userDenies]);
  const literalDenies = readDenies.filter((deny) => !isPatternDeny(deny));
  // Whether reads at `path` are denied: the most specific requested grant or emitted read deny at or above it is a deny (a deny wins a
  // tie). A write-floor row there must not become a read-only grant: being more specific than that deny, the grant would re-open it.
  const requestedGrants = [...readwrite, ...readGrants, ...demoted];
  const depthAbove = (path: string, rules: readonly string[]): number =>
    Math.max(-1, ...rules.filter((rule) => isWindowsPathAtOrUnder(path, rule)).map((rule) => foldPath(rule).length));
  const readDenied = (path: string): boolean => {
    const deny = depthAbove(path, literalDenies.filter((rule) => requestedGrants.some((grant) => strictlyUnder(rule, grant))));
    return deny >= 0 && deny >= depthAbove(path, requestedGrants);
  };

  const readonlyOut: string[] = [...readGrants, ...demoted];
  const denied: string[] = [];
  for (const deny of dedupe(denyWrite)) {
    if (!readwrite.some((grant) => strictlyUnder(deny, grant))) continue;
    if (exists(deny) && !readDenied(deny)) readonlyOut.push(deny);
    else denied.push(deny);
  }
  const allGrants = [...readwrite, ...readonlyOut];
  const rules: MxcRule[] = [
    ...readwrite.map((path) => ({ path, kind: "readwrite" as const })),
    ...readonlyOut.map((path) => ({ path, kind: "readonly" as const })),
    ...literalDenies.filter((deny) => allGrants.some((grant) => strictlyUnder(deny, grant))).map((path) => ({ path, kind: "deny" as const })),
  ];
  const patternMatches = expandPatternDenies(readDenies.filter(isPatternDeny)
    .map((requested) => ({ requested, pattern: normalizedPatternSpelling(requested) })), rules, exists, list).matches;
  for (const deny of literalDenies) {
    if (allGrants.some((grant) => strictlyUnder(deny, grant))) denied.push(deny);
  }
  // A match removed since the walk needs no deny: checked once more as the policy is handed over.
  const presentMatches = patternMatches.filter((match) => allGrants.some((grant) => strictlyUnder(match, grant) || foldPath(match) === foldPath(grant)) && exists(match));
  const firstMissingOf = (deny: string): string => {
    let firstMissing = winPath.normalize(deny);
    for (;;) {
      const parent = winPath.dirname(firstMissing);
      if (exists(parent)) return firstMissing;
      if (parent === firstMissing) throw new Error(`Windows sandbox policy cannot resolve missing deny: ${deny}`);
      firstMissing = parent;
    }
  };
  const inexact = (deny: string): boolean => !exists(deny) && foldPath(firstMissingOf(deny)) !== foldPath(deny);
  const missingCarriers = new Set(dedupe(denied).filter((deny) => requiredWriteDenies.has(foldPath(deny)) && inexact(deny))
    .map((deny) => foldPath(firstMissingOf(deny))));
  const readDeniedExactly = new Set(literalDenies.map(foldPath));
  const watched: string[] = [];
  const raised = [...dedupe(denied).flatMap((deny) => {
    if (!inexact(deny)) return deny;
    const firstMissing = firstMissingOf(deny);
    // A missing parent cannot carry an exact deny, and a deny on the parent would take its other children: the name is watched.
    if (missingCarriers.has(foldPath(firstMissing))) {
      if (readDeniedExactly.has(foldPath(deny))) throw new Error(t("sandboxPolicy.windowsProtectedWriteRefused", { path: deny }));
      watched.push(deny);
      return [];
    }
    if (allGrants.some((grant) => foldPath(firstMissing) === foldPath(grant)) ||
        !readwrite.some((grant) => strictlyUnder(firstMissing, grant))) {
      throw new Error(`Windows sandbox policy cannot raise missing deny within a writable grant: ${deny}`);
    }
    // The shell cannot create this directory this spawn; recompute precise denies next spawn. Approved file tools can still create it.
    return firstMissing;
  }), ...presentMatches];
  return {
    readwrite: readwrite.map(withoutTrailingSeparator),
    readonly: dedupe(readonlyOut).filter((path) => !readwrite.some((grant) => foldPath(grant) === foldPath(path))).map(withoutTrailingSeparator),
    denied: dedupe(raised).filter((path, index, paths) =>
      !paths.some((parent, parentIndex) => parentIndex !== index && isWindowsPathAtOrUnder(path, parent))).map(withoutTrailingSeparator),
    ...withWatched(dedupe(watched), raised, path => path),
  };
}

// The watched rows no raised deny already covers.
function withWatched<T>(watched: readonly T[], denied: readonly string[], pathOf: (row: T) => string): { readonly watched?: readonly T[] } {
  const open = watched.filter(row => !denied.some(deny => isWindowsPathAtOrUnder(pathOf(row), deny)));
  return open.length > 0 ? { watched: open } : {};
}

function expandMxcPolicyPath(path: string): string {
  return WINDOWS_ABSOLUTE.test(path) ? path : expandLeadingTilde(expandWindowsEnvRefs(path));
}

export function isMxcReadPattern(path: string): boolean {
  const spelling = stripExtendedPathPrefix(expandMxcPolicyPath(path));
  return /^[a-z]:[\\/]/i.test(spelling)
    ? PATTERN_SEGMENT.test(spelling)
    : !/^[\\/]|:/u.test(spelling);
}

function* listMxcPatternDirectory(directory: string): Iterable<MxcDirectoryEntry> {
  const route = admitLocalRoute(directory);
  if (route.followedLink) throw new Error("A directory changed while expanding a read deny");
  if (localFs.lstat(route.verdict)?.isDirectory() !== true) return;
  const opened = localFs.opendir(route.verdict);
  try {
    for (let entry = opened.readSync(); entry !== null; entry = opened.readSync()) {
      if (!entry.isSymbolicLink()) {
        yield { name: entry.name, kind: entry.isDirectory() ? "directory" : "file" };
        continue;
      }
      // A listing reports every reparse point as a link; lstat tells a real link from a placeholder directory.
      const target = localFs.lstat(admitLocalPath(winPath.join(route.verdict.path, entry.name)));
      // Removed since the listing: nothing is left to deny.
      if (target === undefined) continue;
      yield { name: entry.name, kind: target.isSymbolicLink() ? "link" : target.isDirectory() ? "reparse-directory" : "file" };
    }
  } finally {
    opened.closeSync();
  }
}

// A policy row as the obligation the ranking below reads. `secrets` rows are the protected floor: a grant at or beneath one is dropped
// unless a pierce covers it. `user-deny` rows drop it too, and no pierce covers them. `ave-home` and `read-boundary` rows are read
// masks a grant at their own path or beneath them re-opens. A read deny is a pattern by its spelling; its matches are admitted when
// the launch is ranked.
function obligationRowsOf(model: PolicyModel): {
  readonly rows: readonly ObligationRow[]; readonly patterns: readonly string[]; readonly userPatterns: readonly string[];
  readonly required: ReadonlySet<string>;
} {
  const rows: ObligationRow[] = [];
  const required = new Set<string>();
  const patterns = new Set<string>();
  const userPatterns = new Set<string>();
  let sessionRoot: string | undefined;
  for (const row of model.rows) {
    const spelling = { path: expandMxcPolicyPath(row.path), literal: true } as const;
    if (isPolicyFloorRow(row)) {
      if (row.access === "ro") {
        rows.push({ spelling, polarity: { effect: "deny", access: "write" }, source: "per-command" });
        if (row.reason === "required-write-deny") required.add(spelling.path);
      }
      else if (isMxcReadPattern(row.path)) {
        patterns.add(stripExtendedPathPrefix(spelling.path));
        if (row.reason === "user-deny") userPatterns.add(stripExtendedPathPrefix(spelling.path));
      } else {
        const source = row.reason === "secrets" ? "floor" : row.reason === "user-deny" ? "settings" : "read-mask";
        rows.push({ spelling, polarity: { effect: "deny", access: "read" }, source });
      }
    } else if (row.reason === "floor-pierce") {
      // The saved-session read exception is withheld on Windows.
      sessionRoot ??= sessionStorePath();
      if (!isWindowsPathAtOrUnder(row.path, sessionRoot)) rows.push({ spelling, polarity: { effect: "allow", access: "lookup" }, source: "per-command" });
    } else {
      rows.push({ spelling, polarity: { effect: "allow", access: row.access === "rw" ? "write" : "read" }, source: row.reason === "user-grant" ? "settings" : "per-command" });
    }
  }
  return { rows, patterns: [...patterns], userPatterns: [...userPatterns], required };
}

interface CanonicalPatternDeny extends SpelledPatternDeny {
  // The admitted object of the literal prefix; undefined for an unanchored pattern.
  readonly prefix: AdmittedObligation | undefined;
}

// A literal prefix is admitted the way a grant is, so the walk and the matcher use the final path the grants carry.
// A prefix that cannot be admitted, or that overlaps a grant under the requested spelling but resolves outside every grant, refuses the launch.
function canonicalPatternSpellings(patterns: readonly string[], grants: readonly AdmittedObligation[]): CanonicalPatternDeny[] {
  const spelled = patterns.map((requested) => ({ requested, pattern: normalizedPatternSpelling(requested) }));
  const prefixes = [...new Set(spelled.filter(({ pattern }) => WINDOWS_ABSOLUTE.test(pattern)).map(({ pattern }) => literalPatternPrefix(pattern)))];
  // Each `~digit` prefix component with its parent: the component is a short name when it opens an object its parent does not list.
  const shortNames = prefixes.flatMap(prefix => prefix.split("\\").flatMap((name, index, components) => index === 0 || !/~\d/.test(name) ? []
    : [{ name, parent: literalPatternPrefix(`${components.slice(0, index).join("\\")}\\*`), child: components.slice(0, index + 1).join("\\") }]));
  const set = admitObligations({ purpose: "mxc-launch", principal: "mxc", rows: [...new Set([...prefixes, ...shortNames.flatMap(({ parent, child }) => [parent, child])])].map(path => ({
    spelling: { path, literal: true }, polarity: { effect: "allow", access: "lookup" }, source: "command-operand",
  })) });
  const admitted = new Map(consumeObligations(set, "mxc-launch").map(entry => [entry.origin.row, entry]));
  const unresolved = new Map(set.unresolved.map(entry => [entry.origin.row, entry.reason]));
  return spelled.map(({ requested, pattern }) => {
    if (!WINDOWS_ABSOLUTE.test(pattern)) return { requested, pattern, prefix: undefined };
    const spelledPrefix = literalPatternPrefix(pattern);
    const prefix = admitted.get(spelledPrefix);
    if (prefix === undefined) {
      throw patternDenyRefusal(requested, `its literal prefix cannot be admitted: ${unresolved.get(spelledPrefix) ?? "incomplete-walk"}`);
    }
    for (const { name, parent, child } of shortNames) {
      if (!isWindowsPathAtOrUnder(spelledPrefix, child)) continue;
      const directory = admitted.get(parent);
      const opened = admitted.get(child);
      if (directory === undefined || opened === undefined) throw patternDenyRefusal(requested, `cannot tell whether ${name} is an 8.3 short name`);
      if (opened.kind !== "missing" && ![...listMxcPatternDirectory(directory.target)].some(entry => entry.name.toLowerCase() === name.toLowerCase())) {
        throw shortNameRefusal(requested, name);
      }
    }
    const overlaps = (a: string, b: string) => isWindowsPathAtOrUnder(a, b) || isWindowsPathAtOrUnder(b, a);
    // Reach: a grant's admitted final path is at, under or above the prefix's admitted final path.
    // Overlap: the same relation by object identity chain, or between the requested prefix spelling and a grant's final
    // path or requested row. Overlap without reach is refused: the spellings disagree on where the prefix is, so a walk
    // from its final path cannot be shown to cover what the grant opens.
    const reaches = grants.some(grant => overlaps(grant.target, prefix.target));
    if (!reaches && grants.some(grant => obligationWithin(grant, prefix) || obligationWithin(prefix, grant)
      || overlaps(spelledPrefix, grant.target) || overlaps(spelledPrefix, stripExtendedPathPrefix(grant.origin.row)))) {
      throw patternDenyRefusal(requested, "its literal prefix overlaps a grant but resolves outside every grant");
    }
    const rest = pattern.slice(spelledPrefix.replace(/\\$/, "").length + 1);
    return { requested, pattern: `${prefix.target.replace(/[\\/]+$/, "")}\\${rest}`, prefix };
  });
}

// Why a reached deny row is left open. The reasons are closed; each names the row by its origin and carries its evidence.
export type MxcDenyException =
  // A floor row whose read grant at the same path takes its place; `grant` is that grant's row.
  | { readonly reason: "lifted-floor"; readonly row: string; readonly grant: string }
  // A host read mask the grant at its own path carves open; `grant` is that grant's row.
  | { readonly reason: "read-mask-carve-out"; readonly row: string; readonly grant: string };

export interface MxcDenyOutcomeInput {
  readonly denies: readonly AdmittedObligation[];
  readonly exceptions: readonly MxcDenyException[];
  readonly patterns: readonly CanonicalPatternDeny[];
  readonly outcomes: ReadonlyMap<string, PatternOutcome>;
  // The grants a pattern prefix is judged against.
  readonly reachable: readonly AdmittedObligation[];
  // This launch's reach: the grants left after every deny.
  readonly reach: readonly AdmittedObligation[];
  readonly result: MxcFilesystemGrants;
}

// A missing write deny is watched when the result records it at the deny's own path, beneath the deny's own anchor object.
function watchedHolds(deny: AdmittedObligation, result: MxcFilesystemGrants): boolean {
  return deny.polarity.access === "write" && deny.kind === "missing" && (result.watched ?? []).some(row =>
    foldPath(row.path) === foldPath(deny.target) && foldPath(row.anchor) === foldPath(deny.anchorTarget)
    && row.volumeSerial === deny.anchor.volumeSerial && row.fileId === deny.anchor.fileId);
}

function exceptionHolds(deny: AdmittedObligation, input: MxcDenyOutcomeInput): boolean {
  // The named grant row is in this launch's reach at the deny's own path, with an access the reason accepts.
  const granted = (row: unknown, access: readonly string[]) => typeof row === "string" && input.reach.some(grant =>
    grant.origin.row === row && grant.polarity.effect === "allow" && access.includes(grant.polarity.access)
    && foldPath(grant.target) === foldPath(deny.target));
  return input.exceptions.filter(candidate => candidate.row === deny.origin.row).some(exception => {
    switch (exception.reason) {
      case "lifted-floor":
        return deny.origin.source === "floor" && granted(exception.grant, ["read"]);
      case "read-mask-carve-out":
        return deny.origin.source === "read-mask" && granted(exception.grant, ["read", "write"]);
      default:
        return false;
    }
  });
}

const DENY_EXCEPTION_REASONS: ReadonlySet<string> = new Set(["lifted-floor", "read-mask-carve-out"] satisfies MxcDenyException["reason"][]);

// Every admitted deny row and every pattern row ends stamped (denied in the result), carried (no granted path reaches it),
// excepted (a closed reason whose evidence this launch holds), watched (an absent protected name recorded with its anchor's
// identity), or the launch is refused.
export function assertMxcDenyOutcomes(input: MxcDenyOutcomeInput): void {
  const { denies, patterns, outcomes, reachable, result } = input;
  const unheld = (row: string) => new Error(`Windows sandbox policy left a deny without an outcome: ${row}`);
  const unknown = input.exceptions.find(exception => !DENY_EXCEPTION_REASONS.has(exception.reason));
  if (unknown !== undefined) {
    throw new Error(`Windows sandbox policy named an unknown deny exception for ${unknown.row}: ${String(unknown.reason)}`);
  }
  for (const deny of denies) {
    const write = deny.polarity.access === "write";
    const stamped = result.denied.some(path => isWindowsPathAtOrUnder(deny.target, path))
      || (write && result.readonly.some(path => foldPath(path) === foldPath(deny.target)));
    const grants = [...result.readwrite, ...(write ? [] : result.readonly)];
    // A grant beneath the deny reaches it too, except a read-mask carve-out or the read grant a floor pierce admits.
    const beneath = deny.origin.source === "read-mask" ? [] : deny.origin.source === "floor" ? result.readwrite : grants;
    const reached = grants.some(grant => isWindowsPathAtOrUnder(deny.target, grant)) || beneath.some(grant => strictlyUnder(grant, deny.target));
    if (!stamped && reached && !watchedHolds(deny, result) && !exceptionHolds(deny, input)) throw unheld(deny.origin.row);
  }
  for (const { requested, pattern, prefix } of patterns) {
    const outcome = outcomes.get(requested);
    if (outcome === undefined) throw unheld(requested);
    if (outcome === "outside-reach" && (prefix === undefined ? reachable.length > 0
      : reachable.some(grant => isWindowsPathAtOrUnder(grant.target, prefix.target) || isWindowsPathAtOrUnder(prefix.target, grant.target)))) {
      throw unheld(`${requested} (${pattern})`);
    }
  }
}

// The Windows container adapter: policy rows in, the three container lists out. Every row is admitted to the object it names
// first, and the ranking compares those objects, never spellings.
export function rankMxcFilesystem(model: PolicyModel): MxcFilesystemGrants {
  const { patterns, userPatterns, required } = obligationRowsOf(model);
  return rankAdmittedMxcFilesystem(admitMxcFilesystem(model), patterns, userPatterns, required);
}

/** The model's literal rows admitted for one container launch; pattern denies are admitted when the launch is ranked. */
export function admitMxcFilesystem(model: PolicyModel): ObligationSet {
  return admitObligations({ purpose: "mxc-launch", principal: "mxc", rows: obligationRowsOf(model).rows });
}

function rankAdmittedMxcFilesystem(
  set: ObligationSet, requestedPatterns: readonly string[], userPatterns: readonly string[], required: ReadonlySet<string>,
): MxcFilesystemGrants {
  requireEnforceable(set);
  if (set.scope.principal !== "mxc") throw new TypeError("Filesystem obligations were issued for another principal");
  const entries = consumeObligations(set, "mxc-launch");
  const allReadDenies = entries.filter(entry => entry.polarity.effect === "deny" && entry.polarity.access === "read");
  const writeDenies = entries.filter(entry => entry.polarity.effect === "deny" && entry.polarity.access === "write");
  const floor = allReadDenies.filter(entry => entry.origin.source === "floor");
  const within = (outer: AdmittedObligation, inner: AdmittedObligation) => obligationWithin(outer, inner)
    && isWindowsPathAtOrUnder(inner.target, outer.target);
  const inside = (outer: AdmittedObligation, inner: AdmittedObligation) => within(outer, inner)
    && foldPath(outer.target) !== foldPath(inner.target);
  const requestedPierces = entries.filter(entry => entry.polarity.access === "lookup" && entry.origin.source === "per-command" && entry.kind !== "missing");
  const sessionRoot = requestedPierces.length > 0 ? sessionStorePath() : undefined;
  const pierces = requestedPierces.filter(entry => sessionRoot === undefined || !isWindowsPathAtOrUnder(entry.target, sessionRoot));
  for (const pierce of pierces) {
    const rule = allReadDenies.find(deny => deny.origin.source === "settings" && within(deny, pierce));
    if (rule !== undefined) throw userDenyCoversPierce(rule.origin.row, pierce.origin.row);
  }
  const baseAllows = entries.filter(entry => entry.polarity.effect === "allow" && entry.polarity.access !== "lookup" && entry.kind !== "missing"
    && !allReadDenies.some(deny => within(deny, entry) && deny.origin.source !== "read-mask"
      && !(deny.origin.source === "floor" && entry.polarity.access === "read"
        && pierces.some(pierce => within(deny, pierce) && within(pierce, entry)))));
  // Remove an exact product floor row only when the read grant takes its place.
  const lifted = floor.filter(deny => pierces.some(pierce => within(deny, pierce) && !inside(deny, pierce))
    && baseAllows.some(grant => grant.polarity.access === "read" && within(deny, grant) && !inside(deny, grant)));
  const readDenies = allReadDenies.filter(deny => !lifted.includes(deny)
    && !(deny.origin.source === "read-mask" && baseAllows.some(grant => within(deny, grant) && !inside(deny, grant))));
  let patterns: CanonicalPatternDeny[] = [];
  let patternOutcomes: ReadonlyMap<string, PatternOutcome> = new Map();
  const patternDenies = requestedPatterns.length === 0 ? [] : withLocalityDecision(() => {
    patterns = canonicalPatternSpellings(requestedPatterns, baseAllows);
    for (const { requested, pattern } of patterns) {
      if (!userPatterns.includes(requested)) continue;
      const pierce = pierces.find(entry => userPatternCovers(pattern, entry.target));
      if (pierce !== undefined) throw userDenyCoversPierce(requested, pierce.origin.row);
    }
    const rules: MxcRule[] = [
      ...baseAllows.map(entry => ({ path: entry.target, kind: entry.polarity.access === "write" ? "readwrite" as const : "readonly" as const })),
      ...readDenies.filter(deny => baseAllows.some(grant => inside(grant, deny))).map(entry => ({ path: entry.target, kind: "deny" as const })),
    ];
    const { matches, outcomes } = expandPatternDenies(patterns, rules, path => {
      const route = admitLocalRoute(path, { projectMissing: true });
      // Roots are admitted final paths: one that now follows a link changed during the walk.
      if (route.followedLink) throw new Error("A pattern deny root changed while expanding a read deny");
      return localFs.lstat(route.verdict) !== undefined;
    }, listMxcPatternDirectory, true, path => localFs.lstat(admitLocalRoute(path, { projectMissing: true }).verdict) !== undefined);
    patternOutcomes = outcomes;
    const matched = admitObligations({ purpose: "mxc-launch", principal: "mxc", rows: matches.map(path => ({
      spelling: { path, literal: true }, polarity: { effect: "deny", access: "read" }, source: "settings",
    })) });
    requireEnforceable(matched);
    return consumeObligations(matched, "mxc-launch").filter(deny => deny.kind !== "missing");
  });
  const allows = baseAllows.filter(grant => !patternDenies.some(deny => within(deny, grant)));
  const writes = allows.filter(entry => entry.polarity.access === "write" && !writeDenies.some(deny => within(deny, entry)));
  const reads = allows.filter(entry => !writes.includes(entry));
  const activeReadDenies = [...readDenies.filter(deny => allows.some(grant => inside(grant, deny))), ...patternDenies];
  const denied = [...activeReadDenies];
  for (const deny of writeDenies) {
    if (!writes.some(grant => inside(grant, deny))) continue;
    const denyDepth = Math.max(-1, ...activeReadDenies.filter(read => within(read, deny)).map(read => read.chain.length));
    const grantDepth = Math.max(-1, ...allows.filter(grant => within(grant, deny)).map(grant => grant.chain.length));
    if (deny.kind === "missing" || denyDepth >= grantDepth) denied.push(deny);
    else reads.push(deny);
  }
  for (const deny of readDenies) {
    if (!denied.includes(deny) && reads.some(grant => inside(grant, deny))) denied.push(deny);
  }
  const firstMissingOf = (deny: AdmittedObligation): string =>
    winPath.join(deny.anchorTarget, winPath.relative(deny.anchorTarget, deny.target).split("\\")[0] ?? "");
  const inexact = (deny: AdmittedObligation): boolean => deny.kind === "missing" && writes.some(grant => inside(grant, deny))
    && foldPath(firstMissingOf(deny)) !== foldPath(deny.target);
  const missingCarriers = new Set(denied.filter(deny => deny.polarity.access === "write" && required.has(deny.origin.row) && inexact(deny))
    .map(deny => foldPath(firstMissingOf(deny))));
  const watched: AdmittedObligation[] = [];
  const raised = denied.flatMap(deny => {
    if (!inexact(deny)) return deny.target;
    const firstMissing = firstMissingOf(deny);
    // A missing parent cannot carry an exact deny, and a deny on the parent would take its other children: the name is watched.
    if (missingCarriers.has(foldPath(firstMissing))) {
      if (deny.polarity.access !== "write") throw new Error(t("sandboxPolicy.windowsProtectedWriteRefused", { path: deny.origin.row }));
      watched.push(deny);
      return [];
    }
    if ([...writes, ...reads].some(grant => foldPath(firstMissing) === foldPath(grant.target))
      || !writes.some(grant => strictlyUnder(firstMissing, grant.target))) {
      throw new Error("Windows sandbox policy cannot raise missing deny within a writable grant");
    }
    return firstMissing;
  });
  const readwrite = dedupe(writes.map(entry => entry.target)).map(withoutTrailingSeparator);
  const result: MxcFilesystemGrants = {
    readwrite,
    readonly: dedupe(reads.map(entry => entry.target)).filter(path => !readwrite.some(write => foldPath(write) === foldPath(path))).map(withoutTrailingSeparator),
    denied: dedupe(raised).filter((path, index, paths) =>
      !paths.some((parent, parentIndex) => parentIndex !== index && isWindowsPathAtOrUnder(path, parent)
        && !allows.some(grant => strictlyUnder(grant.target, parent) && isWindowsPathAtOrUnder(path, grant.target)))).map(withoutTrailingSeparator),
    ...withWatched(watched.map(deny => ({ path: deny.target, anchor: deny.anchorTarget, volumeSerial: deny.anchor.volumeSerial, fileId: deny.anchor.fileId }))
      .filter((row, index, rows) => rows.findIndex(other => foldPath(other.path) === foldPath(row.path)) === index), raised, row => row.path),
  };
  const exceptions: MxcDenyException[] = [
    ...lifted.flatMap(deny => baseAllows.filter(grant => grant.polarity.access === "read" && within(deny, grant) && !inside(deny, grant))
      .map(grant => ({ reason: "lifted-floor" as const, row: deny.origin.row, grant: grant.origin.row }))),
    ...allReadDenies.filter(deny => deny.origin.source === "read-mask" && !readDenies.includes(deny))
      .flatMap(deny => baseAllows.filter(grant => within(deny, grant) && !inside(deny, grant))
        .map(grant => ({ reason: "read-mask-carve-out" as const, row: deny.origin.row, grant: grant.origin.row }))),
  ];
  assertMxcDenyOutcomes({ denies: [...allReadDenies, ...writeDenies, ...patternDenies], exceptions, patterns,
    outcomes: patternOutcomes, reachable: baseAllows, reach: allows, result });
  return result;
}

// The MXC 1.1.0 one-shot request Ave launches. Only the fields Ave sets.
export interface MxcContainerRequest {
  readonly version: typeof MXC_CONFIG_SCHEMA_VERSION;
  readonly containment: "processcontainer";
  readonly process: {
    readonly commandLine: string;
    readonly cwd: string;
    readonly env: readonly string[];
    readonly inheritDefaultEnv: false;
    readonly timeout: number;
  };
  readonly filesystem: {
    readonly readwritePaths: readonly string[];
    readonly readonlyPaths: readonly string[];
    readonly deniedPaths: readonly string[];
  };
  readonly fallback: { readonly allowDaclMutation: false };
  readonly network: {
    readonly egress: { readonly default: "deny" };
    readonly ingress: { readonly default: "allow"; readonly hostLoopback: "allow" };
  };
  readonly runtimeConfig: { readonly networkProxy: string };
  readonly ui: { readonly disable: false; readonly clipboard: "none"; readonly injection: false };
}

export interface MxcShellRequestInput {
  readonly commandLine: string;
  readonly cwd: string;
  readonly grants: MxcFilesystemGrants;
  // The child's whole environment. Proxy variables are dropped: MXC sets them.
  readonly env: Readonly<Record<string, string>>;
  // `http://127.0.0.1:<port>` of this invocation's own listener.
  readonly proxyUrl: string;
  // MXC's own timeout, a backstop behind the host's lifetime watch.
  readonly timeoutMs: number;
}

// Variables MXC derives from `runtimeConfig.networkProxy`; a caller value would contradict it.
const PROXY_ENV_KEYS = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy"]);
// MXC refuses a caller-owned environment block without these (schema.md, "Environment").
const REQUIRED_ENV_KEYS = ["SYSTEMROOT", "LOCALAPPDATA"] as const;

// Never inherit host env or permit ACL-mutating fallback. Request default-deny egress and scope the proxy endpoint to one listener. GUI support is needed by shell runtimes but permits spoofed windows, which are never trusted; clipboard/input injection stay closed. Proxy mode forces ingress capability, so host firewall controls inbound reachability.
export function buildMxcShellRequest(input: MxcShellRequestInput): MxcContainerRequest {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(input.proxyUrl)) {
    throw new Error(`MXC proxy must be an http://127.0.0.1:<port> URL, got ${input.proxyUrl}`);
  }
  const grants = [...input.grants.readwrite, ...input.grants.readonly];
  if (!grants.some((grant) => isWindowsPathAtOrUnder(input.cwd, grant))) {
    throw new Error("MXC working directory must lie inside a granted path");
  }
  const env: string[] = [];
  const present = new Set<string>();
  for (const [key, value] of Object.entries(input.env)) {
    if (key.length === 0 || key.includes("=") || PROXY_ENV_KEYS.has(key.toLowerCase())) continue;
    env.push(`${key}=${value}`);
    present.add(key.toUpperCase());
  }
  const missing = REQUIRED_ENV_KEYS.filter((key) => !present.has(key));
  if (missing.length > 0) throw new Error(`MXC environment is missing ${missing.join(", ")}`);
  return {
    version: MXC_CONFIG_SCHEMA_VERSION,
    containment: "processcontainer",
    process: {
      commandLine: input.commandLine,
      cwd: winPath.normalize(input.cwd),
      env,
      inheritDefaultEnv: false,
      timeout: Math.max(1, Math.ceil(input.timeoutMs)),
    },
    filesystem: {
      readwritePaths: [...input.grants.readwrite],
      readonlyPaths: [...input.grants.readonly],
      deniedPaths: [...input.grants.denied],
    },
    fallback: { allowDaclMutation: false },
    network: { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" } },
    runtimeConfig: { networkProxy: input.proxyUrl },
    ui: { disable: false, clipboard: "none", injection: false },
  };
}

export const MXC_REQUEST_CHARACTER_LIMIT = 1024 * 1024;

function policyTooLarge(length: number, limit: number, cause?: unknown): Error {
  return new Error(`Windows sandbox policy is too large: ${length} characters, limit ${limit}`, { cause });
}

function serializeMxcRequest(request: MxcContainerRequest): string {
  const json = JSON.stringify(request);
  if (json.length > MXC_REQUEST_CHARACTER_LIMIT) throw policyTooLarge(json.length, MXC_REQUEST_CHARACTER_LIMIT);
  return json;
}

function base64RequestArgs(json: string): string[] {
  return ["--config-base64", Buffer.from(json, "utf8").toString("base64")];
}

// Probes remain inline and fail before spawn if their complete command line cannot fit.
export function mxcRequestArgs(request: MxcContainerRequest, launcher: string, prefix: readonly string[] = []): string[] {
  const args = base64RequestArgs(serializeMxcRequest(request));
  const length = windowsCommandLineLength(launcher, [...prefix, ...args]);
  if (length + WINDOWS_COMMAND_LINE_MARGIN >= WINDOWS_COMMAND_LINE_LIMIT) {
    throw policyTooLarge(length, WINDOWS_COMMAND_LINE_LIMIT - WINDOWS_COMMAND_LINE_MARGIN - 1);
  }
  return args;
}

export interface MxcRequestTransport {
  readonly args: readonly string[];
  bindChild(child: ChildProcess): void;
  release(): Promise<void>;
}

export async function openMxcRequestTransport(request: MxcContainerRequest, launcher: string): Promise<MxcRequestTransport> {
  const json = serializeMxcRequest(request);
  const inline = base64RequestArgs(json);
  const length = windowsCommandLineLength(launcher, inline);
  if (length + WINDOWS_COMMAND_LINE_MARGIN < WINDOWS_COMMAND_LINE_LIMIT) {
    return { args: inline, bindChild: () => {}, release: async () => {} };
  }
  const limit = WINDOWS_COMMAND_LINE_LIMIT - WINDOWS_COMMAND_LINE_MARGIN - 1;
  const pipe = String.raw`\\.\pipe\ave-mxc-${randomBytes(16).toString("hex")}`;
  const args = ["--config", pipe];
  if (windowsCommandLineLength(launcher, args) + WINDOWS_COMMAND_LINE_MARGIN >= WINDOWS_COMMAND_LINE_LIMIT) {
    throw policyTooLarge(length, limit);
  }
  try {
    return { args, ...await openMxcPolicyPipe(Buffer.from(json, "utf8"), pipe) };
  } catch (error) {
    // The cause is read only by whoever reports the failure, after its resources are released.
    throw new Error("Windows sandbox policy pipe could not be opened", { cause: error });
  }
}

// The container command line for one PowerShell command. `-EncodedCommand` carries the command as UTF-16LE base64, so no quoting of the command's own text can change how the line splits.
export function powerShellMxcCommandLine(systemRoot: string, command: string): string {
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  return `"${win32SystemBinary("WindowsPowerShell/v1.0/powershell", { SystemRoot: systemRoot })}" ${WIN32_POWERSHELL_STARTUP_ARGS.join(" ")} -EncodedCommand ${encoded}`;
}

// Why the Bash tool does not run under MXC, for the tool result.
export const MXC_BASH_UNAVAILABLE_MESSAGE =
  "Bash cannot run in the Windows sandbox on this host: Ave confines shell commands with " +
  "Microsoft Execution Containers here, and Git Bash (MSYS2) cannot start inside a container " +
  "(it is denied the named-object directory it creates at startup). Use the PowerShell tool " +
  "for this command. To run it in Git Bash anyway, retry with executionMode \"host\" and a " +
  "justification; that runs it unsandboxed after your approval.";

async function sha256OfFile(path: string): Promise<string> {
  const [{ createHash }, { readFile }] = await Promise.all([import("node:crypto"), import("node:fs/promises")]);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// One verification per launcher path per process: boot, then every launch reuses it.
const verifiedLaunchers = new Map<string, Promise<string>>();

// `<resources>/mxc/<arch>/wxc-exec.exe` for this host, after its sha256 has matched the pin (once per process). Throws, so the command fails closed, when MXC does not ship for this arch or the file is not the pinned build. Assumption: the installer is per-machine (`nsis.perMachine`), so the file lives in a directory only administrators can write and cannot be swapped between this check and a later launch by the signed-in user. A source checkout's `resources/` is user-writable; that is a developer setup.
export async function resolveHostWxcExecPath(): Promise<string> {
  const { getHostResources } = await import("../main/host-resources.js");
  const path = wxcExecPathFor(getHostResources().resourcePath, process.arch);
  if (path === undefined) throw new Error(`Microsoft Execution Containers do not ship for ${process.arch}`);
  let verified = verifiedLaunchers.get(path);
  if (verified === undefined) {
    const pinned = pinnedWxcExecSha256(process.arch);
    verified = sha256OfFile(path).then((digest) => {
      if (digest !== pinned) throw new Error(`Microsoft Execution Containers launcher ${path} is not the pinned build`);
      return path;
    });
    verifiedLaunchers.set(path, verified);
  }
  return await verified;
}

type HostProbe = (deps: DetectMxcSupportDeps) => Promise<MxcSupport>;

// Run one detection step against this host's shipped binary, in a fresh probe directory.
async function withHostMxcDeps(step: HostProbe): Promise<MxcSupport> {
  const [{ execFile }, { existsSync }, { mkdtemp, rm }, os, path, { getHostResources }] = await Promise.all([
    import("node:child_process"),
    import("node:fs"),
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
    import("../main/host-resources.js"),
  ]);
  // The probe containers write only into a fresh directory of their own.
  const probeDirectory = process.platform === "win32" ? await mkdtemp(path.join(os.tmpdir(), "ave-mxc-probe-")) : os.tmpdir();
  try {
    return await step({
      platform: process.platform,
      arch: process.arch,
      resourcePath: getHostResources().resourcePath,
      windowsBuild: process.platform === "win32" ? os.release() : null,
      exists: existsSync,
      sha256: sha256OfFile,
      probeDirectory,
      systemRoot: process.platform === "win32" ? windowsSystemRoot() : "",
      run: (file, args, timeoutMs) =>
        new Promise((resolve, reject) => {
          execFile(file, [...args], { cwd: path.dirname(file), timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
            if (error !== null && code === null) {
              reject(error);
              return;
            }
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          });
        }),
    });
  } finally {
    if (probeDirectory !== os.tmpdir()) await rm(probeDirectory, { recursive: true, force: true });
  }
}

// detectMxcPrerequisites against this host's shipped binary (boot path).
export async function detectHostMxcPrerequisites(): Promise<MxcSupport> {
  return await withHostMxcDeps(detectMxcPrerequisites);
}

// probeMxcPowerShellStart against this host's shipped binary (after boot).
export async function probeHostMxcPowerShellStart(): Promise<MxcSupport> {
  // The probe starts a container too: a runtime root that was not proved private refuses it, under its own reason.
  const { MxcRuntimeRootError, requireMxcContainerStartRoot } = await import("./mxc-runtime-root.js");
  try {
    requireMxcContainerStartRoot();
  } catch (error) {
    if (!(error instanceof MxcRuntimeRootError)) throw error;
    return { state: "unavailable", reason: "runtime-root-unproved", windowsBuild: null, detail: `runtime root proof failed: ${error.message}` };
  }
  return await withHostMxcDeps(probeMxcPowerShellStart);
}
