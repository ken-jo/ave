import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";

import type { PolicyFile } from "../policy-store.js";
import type { PlatformBridgeAuthority } from "../../shared/chat-origin.js";
import type { ToolInvocationContext } from "../reviewer/risk-classifier.js";
import {
  buildSandboxConfig,
  checkAsrtDependencies,
  isAsrtSandboxSupported,
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  getVendoredSrtWinExePath,
} from "../asrt-sandbox.js";
import { detectSandboxCapability } from "../sandbox-capability.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../sensitive-paths.js";
import { inspectHostRisk } from "../reviewer/host-risk-inspector.js";

// The comparison key the path-scope checks use: canonical form, then case-folded.
export function foldPathForMatch(raw: string): string {
  return caseFoldForMatch(canonicalizePathForMatch(raw));
}

const DEFAULT_ALLOWED_DIRECTORIES = ["/Users/example/work", "/Users/example/.ave"].map(foldPathForMatch);

// The audit rows a gate wrote, in order, whichever field carried them. `AuditLogger.log` takes the row on `input` for a phase that is starting and on `output` for one that ended, and a test reading the trail wants both in the order they were written.
export function auditRowTexts(auditLogger: {
  log: { mock: { calls: unknown[][] } };
}): string[] {
  return auditLogger.log.mock.calls.map(([entry]) => {
    const row = entry as { input?: string; output?: string };
    return row.input ?? row.output ?? "";
  });
}

export function makeTestPolicy(overrides: Partial<PolicyFile> = {}): PolicyFile {
  return {
    version: 1,
    requireExplicitApproval: true,
    managed: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Windows: `checkAsrtDependencies` only proves the srt-win binary + a provisioned `srt-sandbox` user exist — it does NOT prove the box can actually SPAWN a process as that user. `CreateProcessWithLogonW` is denied on managed Windows where a GPO or EDR blocks secondary-logon-as-another-user, so the account + WFP can be fully provisioned yet every wrapped spawn fails access-denied. Probe the real egress fence once (the same call `SandboxManager.initialize` makes); a throw means the sandbox cannot initialize on THIS machine. Memoized — the capability is machine-level and never changes within a run.
let _winSpawnProbe: Promise<boolean> | undefined;
export async function windowsSandboxCanSpawn(): Promise<boolean> {
  if (_winSpawnProbe === undefined) {
    _winSpawnProbe = (async () => {
      const previousCwd = process.cwd();
      try {
        // The srt-sandbox probe inherits cwd. Test worktrees can be user-only, while the provisioned runtime directory is explicitly group-readable.
        const runtimeEntry = createRequire(import.meta.url).resolve(
          "@anthropic-ai/sandbox-runtime",
        );
        process.chdir(dirname(runtimeEntry));
        const mod = await import("@anthropic-ai/sandbox-runtime");
        // ASRT 0.0.67: verifyWindowsWfpEgress needs an EXPLICIT srt-win spawn descriptor — the argless resolve throws (no implicit vendored fallback).
        await mod.verifyWindowsWfpEgress({
          proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE,
          srtWin: mod.resolveSrtWin({ path: getVendoredSrtWinExePath() }),
        });
        return true;
      } catch {
        // Loud, not silent: the sandbox provisioned but cannot actually spawn (CreateProcessWithLogonW access-denied) — the live-init tests are SKIPPED (not hard-failed, so the push is not blocked), but the box is NOT getting OS isolation. Anyone who wants the sandbox on can recover.
        console.warn(
          "[asrt-sandbox] Windows OS sandbox cannot spawn as `srt-sandbox` " +
            "(CreateProcessWithLogonW access-denied, 0x80070005): NOT providing " +
            "isolation on this machine — live-init tests SKIPPED (not run). Fix: " +
            "grant srt-sandbox read+execute on the ASRT backend — `icacls " +
            "node_modules\\@anthropic-ai\\sandbox-runtime /grant " +
            '"sandbox-runtime-users:(OI)(CI)(RX)" /T /C`. See README → ' +
            "'ASRT sandbox access denied' recovery.",
        );
        return false;
      } finally {
        process.chdir(previousCwd);
      }
    })();
  }
  return _winSpawnProbe;
}

// Whether the real ASRT sandbox can actually initialize on this host — supported platform AND no dependency errors (Linux: bwrap + socat + ripgrep), AND (Windows only) the srt-sandbox spawn actually works. Shared by the asrt-sandbox + worker-spawn UDS live tests so each can early-return as a skip on a host that lacks the binaries or is policy-blocked from the sandbox logon. The real boot degrades gracefully to unsandboxed on such a box, and CI covers these live-init paths on Linux/mac + the Windows-logic suite covers win32 logic.
export async function asrtCanInitialize(): Promise<boolean> {
  if (!(await isAsrtSandboxSupported())) return false;
  const deps = await checkAsrtDependencies();
  if (deps.errors.length > 0) return false;
  if (process.platform === "win32" && !(await windowsSandboxCanSpawn())) return false;
  assertNoMachineDenyTargets();
  return true;
}

// Real init stamps srt-win ACLs on every deny target, creating missing ones; fail before it can touch a machine-owned directory.
function assertNoMachineDenyTargets(): void {
  if (process.platform !== "win32") return;
  const roots = [process.env.ProgramData, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.SystemRoot]
    .filter((root): root is string => Boolean(root?.trim()))
    .map((root) => caseFoldForMatch(resolve(root)) + sep);
  const reached = buildSandboxConfig({ allowedDomains: [] }).filesystem.denyWrite
    .map((entry) => typeof entry === "string" ? entry : entry.path)
    .filter((path) => roots.some((root) => caseFoldForMatch(resolve(path)).startsWith(root)));
  if (reached.length > 0) throw new Error(`Real sandbox init would stamp machine-owned paths: ${reached.join(", ")}`);
}

// A paired-platform controller authority whose revocation guard answers `current`. Shared because two suites need the same fixture for opposite reasons — one drives the away answerer directly, the other drives it through `ApprovalGate` — and a second copy would let the two drift into testing different objects. The guard is the only thing that can retire an already-admitted turn, so tests control it here rather than standing up a whole platform runtime.
export function makePlatformBridgeAuthority(
  current = true,
): PlatformBridgeAuthority {
  return {
    kind: "platform-bridge",
    actorId: "actor-digest",
    bridgeBinding: {
      bridgeId: "bridge-1",
      bridgeEpoch: 1,
      routeId: "route-1",
      routeEpoch: 1,
      scope: "scope-1",
    },
    bridgeGuard: { isCurrent: () => current },
  };
}

export function makeRiskClassifierContext(
  overrides: Partial<ToolInvocationContext>,
): ToolInvocationContext {
  return {
    toolName: "test_tool",
    source: "builtin",
    category: "write",
    pathFields: ["path"],
    trustOrigin: "user-keyboard",
    finalInput: {},
    executionCwd: process.cwd(),
    allowedDirectories: DEFAULT_ALLOWED_DIRECTORIES,
    sensitivePathsAdjacent: [],
    sandboxCapability: detectSandboxCapability(),
    ...overrides,
  };
}

// The first audit row whose text starts with `marker`, or undefined.
export function auditRowStartingWith(
  auditLogger: { log: { mock: { calls: unknown[][] } } },
  marker: string,
): string | undefined {
  return auditRowTexts(auditLogger).find((row) => row.startsWith(marker));
}

// Classify a builtin shell command the way the host does before review.
export function inspectBuiltinCommandRisk(command: string) {
  return inspectHostRisk({ source: "builtin", finalInput: { command } });
}

/** A Seatbelt `subpath` or `literal` filter, spelled as the ASRT profile spells it. */
export const pathFilter = (kind: "subpath" | "literal", path: string): string => `(${kind} ${JSON.stringify(path)})`;

/** The path a folded regex filter names, one per alternative; undefined for any other regex. */
export function expandFoldedPathFilter(filter: string): string[] | undefined {
  const match = /^\(regex ("(?:[^"\\]|\\.)*")\)$/u.exec(filter);
  if (!match) return undefined;
  const source = JSON.parse(match[1]!) as string;
  const shape = /^\^((?:\\.|[^\\.*+?^${}()|[\]])*)\/\(((?:\\.|[^\\.*+?^${}()|[\]])*(?:\|(?:\\.|[^\\.*+?^${}()|[\]])*)*)\)(\(\/\.\*\)\?)?\$$/u
    .exec(source);
  if (!shape) return undefined;
  const unescape = (text: string): string => text.replace(/\\(.)/gu, "$1");
  const kind = shape[3] === undefined ? "literal" : "subpath";
  return (shape[2]!.match(/(?:\\.|[^|\\])+/gu) ?? []).map((name) => pathFilter(kind, `${unescape(shape[1]!)}/${unescape(name)}`));
}

/** The profile's rules, each as its head and the sorted filters it matches, folded regexes expanded. */
export function profileRules(profile: string): { head: string; filters: string[] }[] {
  const out: { head: string; filters: string[] }[] = [];
  const lines = profile.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const head = lines[index]!;
    if (!/^\((allow|deny) /u.test(head) || head.endsWith(")")) {
      if (head.trim() !== "") out.push({ head, filters: [] });
      continue;
    }
    const filters: string[] = [];
    while (!lines[index + 1]!.startsWith("  (with message")) {
      const filter = lines[++index]!.trim();
      filters.push(...(expandFoldedPathFilter(filter) ?? [filter]));
    }
    index++;
    out.push({ head, filters: filters.sort() });
  }
  return out;
}

/** The profile a wrapped argv carries, unquoted from the shell word that passes it to `sandbox-exec -p`. */
export function profileOfWrappedArgv(argv: readonly string[]): string {
  const command = argv.join("\n");
  const start = command.indexOf("(version 1)");
  const end = command.lastIndexOf('_SBX"))') + '_SBX"))'.length;
  if (start < 0) throw new Error(`no sandbox profile in the wrapped argv: ${command.slice(0, 300)}`);
  return command.slice(start, end).split(`'"'"'`).join("'");
}
