import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { MAX_WALK_UP } from "./sensitive-paths.js";
import { parseSandboxWrappedWords, quoteSandboxWrappedWord } from "./sandbox-wrapped-command.js";

/** Only the option forms emitted by the pinned Linux wrapper are understood. */
const BWRAP_OPTION_ARITY = {
  "--new-session": 0,
  "--die-with-parent": 0,
  "--unshare-net": 0,
  "--unshare-pid": 0,
  "--unshare-user": 0,
  "--disable-userns": 0,
  "--cap-drop": 1,
  "--cap-add": 1,
  "--unsetenv": 1,
  "--setenv": 2,
  "--ro-bind": 2,
  "--bind": 2,
  "--tmpfs": 1,
  "--dev": 1,
  "--proc": 1,
} as const;

/** Root-process exit is a cleanup boundary only while its descendants stay isolated. */
const BWRAP_LIFETIME_OPTIONS = ["--new-session", "--die-with-parent", "--unshare-pid"] as const;

/** Resolve symlinked prefixes, including when the mount target does not exist yet. */
function mountIdentity(target: string): string {
  const path = resolve(target);
  let ancestor = path;
  for (let depth = 0; depth <= MAX_WALK_UP; depth++) {
    try {
      return resolve(realpathSync.native(ancestor), relative(ancestor, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Linux sandbox wrapper cannot establish mount identity", { cause: error });
      }
    }
    let entry;
    try {
      entry = lstatSync(ancestor, { throwIfNoEntry: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Linux sandbox wrapper cannot establish mount identity", { cause: error });
      }
    }
    if (entry) throw new Error("Linux sandbox wrapper cannot establish mount identity");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  throw new Error("Linux sandbox wrapper cannot establish mount identity");
}

/** The two lists of the wrap's own filesystem section that decide a re-allow. */
export interface LinuxWrapFilesystem {
  /** The wrap's read re-allows, as handed to ASRT. */
  readonly allowRead?: readonly string[];
  /** The wrap's write denies, as handed to ASRT. */
  readonly denyWrite?: readonly string[];
}

interface WrapperOption {
  readonly option: string;
  readonly operands: readonly string[];
  /** Mount identity of the target, for the mount options only. */
  readonly identity?: string;
}

interface BwrapCapabilityState {
  unsharedUserNamespace: boolean;
  allCapabilitiesDropped: boolean;
}

/** Permit only the capability mapping sequence emitted by the pinned helper. */
function assertBwrapCapabilityOption(option: string, operands: readonly string[], state: BwrapCapabilityState): void {
  if (option === "--unshare-user") state.unsharedUserNamespace = true;
  if (option === "--cap-drop" && operands[0] === "ALL") state.allCapabilitiesDropped = true;
  if (option !== "--cap-add") return;
  if (operands[0] !== "CAP_SETFCAP") {
    throw new Error("Linux sandbox wrapper has an unsupported capability addition");
  }
  if (!state.unsharedUserNamespace || !state.allCapabilitiesDropped) {
    throw new Error("Linux sandbox wrapper capability addition requires an isolated user namespace and dropped capabilities");
  }
}

function isAtOrUnder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);
}

/**
 * Put back what a read re-allow shadows.
 *
 * ASRT masks a read-denied directory with a tmpfs and then, inside it, binds
 * the write roots back first and the read re-allows after them. When a
 * re-allow names a directory that HOLDS a write root — a plugin child reading
 * its own root with its data directory inside — the read-only bind of the
 * parent lands on top of the child's writable bind, and the data directory
 * becomes read-only. Every mount made inside the re-allowed directory since
 * the last mount at or above it is therefore made again right after it, in
 * order, so the subtree ends as it was before the re-allow covered it. A write
 * bind under one of the wrap's write denies is not put back: there the deny's
 * own read-only bind, emitted later, is the answer ASRT intends.
 */
function replayShadowedMounts(options: readonly WrapperOption[], filesystem: LinuxWrapFilesystem): WrapperOption[] {
  const reallows = new Set((filesystem.allowRead ?? []).map((path) => mountIdentity(path)));
  const writeDenies = (filesystem.denyWrite ?? []).map((path) => mountIdentity(path));
  const out = [...options];
  for (let index = 0; index < out.length; index++) {
    const reallow = out[index]!;
    if (reallow.option !== "--ro-bind" || reallow.identity === undefined || !reallows.has(reallow.identity)) continue;
    if (resolve(reallow.operands[0]!) !== resolve(reallow.operands[1]!)) continue;
    const target = reallow.identity;
    let covering = index - 1;
    while (covering >= 0) {
      const identity = out[covering]!.identity;
      if (identity !== undefined && isAtOrUnder(target, identity)) break;
      covering--;
    }
    const shadowed = out.slice(covering + 1, index).filter((candidate) => {
      if (candidate.identity === undefined || candidate.identity === target || !isAtOrUnder(candidate.identity, target)) {
        return false;
      }
      return !(candidate.option === "--bind" && writeDenies.some((deny) => isAtOrUnder(candidate.identity!, deny)));
    });
    out.splice(index + 1, 0, ...shadowed);
  }
  return out;
}

/** {@link replayShadowedMounts} over the wrapper's command line; the line itself when nothing was shadowed. */
function replayShadowedWrap(command: string, filesystem: LinuxWrapFilesystem): string {
  if ((filesystem.allowRead ?? []).length === 0) return command;
  const words = parseSandboxWrappedWords(command, "Linux sandbox wrapper");
  if (basename(words[0]?.value ?? "") !== "bwrap") {
    throw new Error("Linux sandbox wrapper does not invoke bubblewrap");
  }
  const options: WrapperOption[] = [];
  const capabilities: BwrapCapabilityState = { unsharedUserNamespace: false, allCapabilitiesDropped: false };
  let index = 1;
  while (index < words.length && words[index]?.value !== "--") {
    const option = words[index]!.value;
    if (!Object.hasOwn(BWRAP_OPTION_ARITY, option)) {
      throw new Error(`Linux sandbox wrapper has an unsupported option: ${option}`);
    }
    const arity = BWRAP_OPTION_ARITY[option as keyof typeof BWRAP_OPTION_ARITY];
    if (index + arity >= words.length || words.slice(index + 1, index + arity + 1).some((word) => word.value === "--")) {
      throw new Error(`Linux sandbox wrapper has a missing operand: ${option}`);
    }
    const operands = words.slice(index + 1, index + arity + 1).map((word) => word.value);
    assertBwrapCapabilityOption(option, operands, capabilities);
    const mounts = ["--tmpfs", "--bind", "--ro-bind", "--dev", "--proc"].includes(option);
    const target = operands.at(-1);
    if (mounts && (target === undefined || !isAbsolute(target))) {
      throw new Error(`Linux sandbox wrapper has an invalid mount target: ${option}`);
    }
    options.push(mounts ? { option, operands, identity: mountIdentity(resolve(target!)) } : { option, operands });
    index += arity + 1;
  }
  if (words[index]?.value !== "--") throw new Error("Linux sandbox wrapper has no command separator");
  const replayed = replayShadowedMounts(options, filesystem);
  if (replayed.length === options.length) return command;
  const optionText = replayed.flatMap((entry) => [entry.option, ...entry.operands]).map(quoteSandboxWrappedWord).join(" ");
  return `${command.slice(0, words[1]!.start)}${optionText} ${command.slice(words[index]!.start)}`;
}

/**
 * A read-denied directory is a writable tmpfs in the Linux wrapper. Its
 * write-deny bind is skipped because the host directory is hidden, leaving the
 * child able to create files in that tmpfs. Remount a mask only when it is the
 * final mount at its exact target. A later write bind at that same target is an
 * intentional grant; a nested bind is a separate mount and stays writable.
 *
 * Before that, a write root a read re-allow of its parent shadowed is bound
 * again ({@link replayShadowedMounts}), when the wrap's own `filesystem` is
 * known.
 */
export function hardenLinuxSandboxWrap<T extends { readonly argv: string[]; readonly env: NodeJS.ProcessEnv }>(
  wrapped: T,
  filesystem: LinuxWrapFilesystem = {},
): T {
  if (wrapped.argv.length !== 3 || wrapped.argv[1] !== "-c") {
    throw new Error("Linux sandbox wrapper has an unexpected command shape");
  }
  const command = replayShadowedWrap(wrapped.argv[2], filesystem);
  const words = parseSandboxWrappedWords(command, "Linux sandbox wrapper");
  if (basename(words[0]?.value ?? "") !== "bwrap") {
    throw new Error("Linux sandbox wrapper does not invoke bubblewrap");
  }
  const maskedDirectories = new Map<string, string>();
  const finalMounts = new Map<string, "mask" | "write" | "read" | "special">();
  const emittedOptions = new Set<string>();
  const capabilities: BwrapCapabilityState = { unsharedUserNamespace: false, allCapabilitiesDropped: false };
  let index = 1;
  while (index < words.length && words[index]?.value !== "--") {
    const option = words[index]!.value;
    if (!Object.hasOwn(BWRAP_OPTION_ARITY, option)) {
      throw new Error(`Linux sandbox wrapper has an unsupported option: ${option}`);
    }
    const arity = BWRAP_OPTION_ARITY[option as keyof typeof BWRAP_OPTION_ARITY];
    if (index + arity >= words.length || words.slice(index + 1, index + arity + 1).some((word) => word.value === "--")) {
      throw new Error(`Linux sandbox wrapper has a missing operand: ${option}`);
    }
    const operands = words.slice(index + 1, index + arity + 1).map((word) => word.value);
    assertBwrapCapabilityOption(option, operands, capabilities);
    emittedOptions.add(option);
    if (["--tmpfs", "--bind", "--ro-bind", "--dev", "--proc"].includes(option)) {
      const target = words[index + arity]!.value;
      if (!isAbsolute(target)) throw new Error(`Linux sandbox wrapper has an invalid mount target: ${option}`);
      const path = resolve(target);
      const identity = mountIdentity(path);
      if (option === "--bind" || option === "--ro-bind") {
        const source = words[index + 1]!.value;
        if (!isAbsolute(source) || (option === "--bind" && resolve(source) !== path)) {
          throw new Error(`Linux sandbox wrapper has an unsupported mount source: ${option}`);
        }
      }
      if (option === "--tmpfs") maskedDirectories.set(identity, path);
      finalMounts.set(identity, option === "--tmpfs" ? "mask" : option === "--bind" ? "write" : option === "--ro-bind" ? "read" : "special");
    }
    index += arity + 1;
  }
  const separator = index;
  if (words[separator]?.value !== "--" || separator + 4 !== words.length || words[separator + 2]?.value !== "-c") {
    throw new Error("Linux sandbox wrapper has no command separator");
  }
  for (const option of BWRAP_LIFETIME_OPTIONS) {
    if (!emittedOptions.has(option)) {
      throw new Error(`Linux sandbox wrapper is missing required process isolation: ${option}`);
    }
  }
  const remountTargets = [...maskedDirectories].filter(([identity]) => {
    const final = finalMounts.get(identity);
    if (final === "special") throw new Error("Linux sandbox wrapper replaces a mask with an unsupported mount");
    return final === "mask";
  }).map(([, path]) => path);
  if (remountTargets.length === 0) {
    return command === wrapped.argv[2] ? wrapped : { ...wrapped, argv: [wrapped.argv[0], wrapped.argv[1], command] };
  }

  const remounts = remountTargets
    .flatMap((path) => ["--remount-ro", path])
    .map(quoteSandboxWrappedWord)
    .join(" ");
  const insertion = words[separator].start;
  const hardened = `${command.slice(0, insertion)}${remounts} ${command.slice(insertion)}`;
  return {
    ...wrapped,
    argv: [wrapped.argv[0], wrapped.argv[1], hardened],
  };
}
