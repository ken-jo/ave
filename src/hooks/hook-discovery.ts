// Hook hashes require explicit acceptance; new or changed hooks stay quarantined in .disabled. Fresh installs ship an empty protected directory without bootstrapping trust (docs/architecture/permission-policy-design.md).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve as pathResolve } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";
import type { ScriptHookType } from "./script-hook-types.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { clearHookDisableCause, disabledHookOriginalName, readHookDisableCause, writeHookDisableCause, type HookDisableCause } from "./hook-disable-state.js";

const log = createLogger("hook-discovery");

export interface DiscoveredHook {
  path: string;
  fileName: string;
  hookType: ScriptHookType;
  sha256: string;
  size: number;
  // Optional header matcher restricts tool names; absence matches all.
  matcher?: string;
}

export type LockfileTrustState = "new" | "changed" | "trusted" | "removed";

export interface LockfileEntry {
  fileName: string;
  sha256: string;
  // ISO timestamp when first accepted by user.
  acceptedAt: string;
}

export interface LockfileShape {
  // Bump when the persisted shape changes.
  schemaVersion: 1;
  updatedAt: string;
  hooks: LockfileEntry[];
}

export interface HookDiff {
  hook: DiscoveredHook;
  state: LockfileTrustState;
  // Last-known hash from lockfile (only set for `changed` / `removed`).
  previousSha256?: string;
}

// Keep hooks outside the app home so a compromised app cannot mutate its own trust root.
export function defaultHooksDir(): string {
  return pathResolve(homedir(), ".config", "ave", "hooks");
}

export function defaultLockfilePath(): string {
  return pathResolve(defaultHooksDir(), ".lockfile.json");
}

// Rejected hooks remain inspectable in .disabled and cannot run.
export function defaultDisabledDir(): string {
  return pathResolve(defaultHooksDir(), ".disabled");
}

// Discovery requires the supply-chain root to exist with mode 0o700.
export function ensureHooksDirectory(dir: string = defaultHooksDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function hookTypeFromName(fileName: string): ScriptHookType | null {
  const lower = fileName.toLowerCase();
  if (extname(lower) !== ".sh") return null;
  if (lower.startsWith("pre-")) return "pre";
  if (lower.startsWith("post-")) return "post";
  if (lower.startsWith("perm-")) return "perm";
  return null;
}

function parseMatcher(buf: Buffer): string | undefined {
  // Only scan the first 1KB (the directive must be in the header comment block).
  const head = buf.subarray(0, 1024).toString("utf-8");
  const m = head.match(/^#[\t ]*ave-hook-matcher:[\t ]*([^\r\n]*)/m);
  return m ? m[1].trim() : undefined;
}

function sha256OfFile(path: string): { sha256: string; size: number; matcher?: string } {
  const buf = readFileSync(path);
  return {
    sha256: sha256Hex(buf),
    size: buf.byteLength,
    matcher: parseMatcher(buf),
  };
}

// Matchers made only of these characters are exact names, split on `|` or `,`.
const EXACT_MATCHER = /^[A-Za-z0-9_\- ,|]+$/u;

const HOOK_MATCHER_PATTERN_MAX = 256;
const HOOK_MATCHER_SUBJECT_MAX = 256;

export class HookMatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookMatcherError";
  }
}

// Bound backtracking without changing the regular expression engine.
function validateMatcherRepetition(pattern: string): void {
  let inClass = false;
  let groupDepth = 0;
  let choicePoints = 0;
  let topLevelAlternation = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\") {
      if (!inClass && /[1-9k]/u.test(pattern[i + 1] ?? "")) {
        throw new HookMatcherError("matcher backreferences are not supported");
      }
      i += 1;
      continue;
    }
    if (char === "[") inClass = true;
    if (char === "]") inClass = false;
    if (inClass) continue;
    if (char === "(") groupDepth += 1;
    if (char === ")") groupDepth -= 1;
    if (char === "|") {
      if (groupDepth > 0) choicePoints += 1;
      else topLevelAlternation = true;
    }
    const counted = char === "{" ? /^\{\d+(?:,\d*)?\}/u.exec(pattern.slice(i))?.[0] : undefined;
    const quantified = char === "*" || char === "+" || (char === "?" && pattern[i - 1] !== "(") || counted !== undefined;
    if (!quantified) continue;
    if (pattern[i - 1] === ")") {
      throw new HookMatcherError("matcher quantified groups are not supported");
    }
    choicePoints += 1;
    if (counted) {
      if (counted.match(/\d+/gu)!.some((value) => Number(value) > HOOK_MATCHER_SUBJECT_MAX)) {
        throw new HookMatcherError("matcher repetition exceeds subject limit");
      }
      i += counted.length - 1;
    }
    if (pattern[i + 1] === "?") i += 1;
  }
  const limit = pattern.startsWith("^") && !topLevelAlternation ? 3 : 2;
  if (choicePoints > limit) {
    throw new HookMatcherError(`matcher supports at most ${limit} quantified atoms or grouped alternatives`);
  }
}

// Reject invalid matchers instead of silently matching nothing; exact name lists and regular expressions share this contract.
export function hookMatcherError(matcher: string | undefined): string | undefined {
  try {
    compileHookMatcher(matcher);
    return undefined;
  } catch (err) {
    if (!(err instanceof HookMatcherError)) throw err;
    return err.message;
  }
}

// Absent, empty or * matchers match all; simple name lists match exactly, other patterns are unanchored regex. Enforce length and repetition bounds before dispatch and compile once per registry.
export function compileHookMatcher(matcher: string | undefined): (subject: string) => boolean {
  if (matcher !== undefined && matcher.length > HOOK_MATCHER_PATTERN_MAX) {
    throw new HookMatcherError(`matcher exceeds ${HOOK_MATCHER_PATTERN_MAX} characters`);
  }
  let matches: (subject: string) => boolean;
  if (!matcher || matcher === "*") matches = () => true;
  else if (EXACT_MATCHER.test(matcher)) {
    const names = new Set(matcher.split(/[|,]/u).map((name) => name.trim()));
    matches = (subject) => names.has(subject);
  } else {
    validateMatcherRepetition(matcher);
    let regex: RegExp;
    try {
      regex = new RegExp(matcher);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new HookMatcherError(error.message);
    }
    matches = (subject) => regex.test(subject);
  }
  return (subject) => {
    if (subject.length > HOOK_MATCHER_SUBJECT_MAX) {
      throw new HookMatcherError(`matcher subject exceeds ${HOOK_MATCHER_SUBJECT_MAX} characters`);
    }
    return matches(subject);
  };
}

// Ignore non-hook filenames and never walk .disabled.
export function discoverHooks(dir: string = defaultHooksDir(), includeDisabledCopies = false): DiscoveredHook[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    log.warn("hook-discovery: failed to read dir %s: %s", dir, (err as Error).message);
    return [];
  }
  const out: DiscoveredHook[] = [];
  for (const fileName of entries) {
    if (fileName.startsWith(".")) continue; // skip dotfiles + .disabled/.lockfile
    const path = join(dir, fileName);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const hookType = hookTypeFromName(includeDisabledCopies ? disabledHookOriginalName(fileName) ?? "" : fileName);
    if (!hookType) continue;
    let h: { sha256: string; size: number; matcher?: string };
    try {
      h = sha256OfFile(path);
    } catch (err) {
      log.warn("hook-discovery: hash failed for %s: %s", path, (err as Error).message);
      continue;
    }
    const matcherError = hookMatcherError(h.matcher);
    if (matcherError !== undefined) {
      // Retained for review and for a denial guard on blocking tool events.
      log.warn("hook-discovery: %s matcher %s is invalid (%s)", path, JSON.stringify(h.matcher), matcherError);
    }
    out.push({ path, fileName, hookType, sha256: h.sha256, size: h.size, matcher: h.matcher });
  }
  // Alphabetical discovery keeps review order stable.
  out.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return out;
}

// Missing or malformed lockfiles trust nothing; malformed files also warn.
export function readLockfile(path: string = defaultLockfilePath()): LockfileShape | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as LockfileShape;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.hooks)) {
      log.warn("hook-discovery: lockfile schema mismatch at %s — treating as missing", path);
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn("hook-discovery: lockfile read failed %s: %s", path, (err as Error).message);
    return null;
  }
}

// Removed hooks are informational and require no user action.
export function diffAgainstLockfile(
  discovered: DiscoveredHook[],
  lockfile: LockfileShape | null,
): HookDiff[] {
  const out: HookDiff[] = [];
  const known = new Map<string, LockfileEntry>();
  if (lockfile) {
    for (const e of lockfile.hooks) known.set(e.fileName, e);
  }
  for (const hook of discovered) {
    const prev = known.get(hook.fileName);
    if (!prev) {
      out.push({ hook, state: "new" });
      continue;
    }
    if (prev.sha256 !== hook.sha256) {
      out.push({ hook, state: "changed", previousSha256: prev.sha256 });
      continue;
    }
    out.push({ hook, state: "trusted" });
  }
  const seen = new Set(discovered.map((d) => d.fileName));
  if (lockfile) {
    for (const e of lockfile.hooks) {
      if (!seen.has(e.fileName)) {
        out.push({
          hook: {
            path: "",
            fileName: e.fileName,
            hookType: hookTypeFromName(e.fileName) ?? "pre",
            sha256: e.sha256,
            size: 0,
          },
          state: "removed",
          previousSha256: e.sha256,
        });
      }
    }
  }
  return out;
}

// Persist only explicitly trusted hooks; quarantine others first. Atomic writes under withFileLock prevent concurrent boot corruption.
export async function persistLockfile(
  acceptedHooks: DiscoveredHook[],
  lockfilePath: string = defaultLockfilePath(),
  previousAcceptedAt?: Map<string, string>,
): Promise<LockfileShape> {
  const now = new Date().toISOString();
  const next: LockfileShape = {
    schemaVersion: 1,
    updatedAt: now,
    hooks: acceptedHooks.map((h) => ({
      fileName: h.fileName,
      sha256: h.sha256,
      acceptedAt: previousAcceptedAt?.get(h.fileName) ?? now,
    })),
  };
  await withFileLock(lockfilePath, async () => {
    mkdirSync(dirname(lockfilePath), { recursive: true, mode: 0o700 });
    writeFileSync(lockfilePath, JSON.stringify(next, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return next;
}

// Move a hook into `.disabled/`, recording why it must not run. Collisions keep separate copies and separate cause records; only explicit user disables may clear matcher guards. A failed cause write leaves an unmarked, fail-closed file.
export function disableHook(
  hook: DiscoveredHook,
  disabledDir: string = defaultDisabledDir(),
  cause: HookDisableCause,
): string {
  mkdirSync(disabledDir, { recursive: true, mode: 0o700 });
  let dest = join(disabledDir, hook.fileName);
  if (existsSync(dest)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    dest = join(disabledDir, `${hook.fileName}.${ts}`);
  }
  // A stale record from an earlier manual move must not survive a crash before the write.
  clearHookDisableCause(dest);
  renameSync(hook.path, dest);
  try {
    writeHookDisableCause(dest, cause);
  } catch (err) {
    // A stale or planted record must not outlive the failed write.
    try {
      clearHookDisableCause(dest);
    } catch { /* Reported below through the resulting state. */ }
    log.warn("hook-discovery: disable cause not recorded for %s (%s); resulting cause: %s", dest, (err as Error).message, readHookDisableCause(dest));
  }
  return dest;
}

// Preserve original acceptedAt timestamps when rewriting trust records.
export function buildAcceptedAtMap(lockfile: LockfileShape | null): Map<string, string> {
  const out = new Map<string, string>();
  if (lockfile) {
    for (const e of lockfile.hooks) out.set(e.fileName, e.acceptedAt);
  }
  return out;
}
