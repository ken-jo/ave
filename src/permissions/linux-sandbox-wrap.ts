import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { MAX_WALK_UP } from "./sensitive-paths.js";

/** Only the option forms emitted by the pinned Linux wrapper are understood. */
const BWRAP_OPTION_ARITY = {
  "--new-session": 0,
  "--die-with-parent": 0,
  "--unshare-net": 0,
  "--unshare-pid": 0,
  "--unshare-user": 0,
  "--cap-drop": 1,
  "--unsetenv": 1,
  "--setenv": 2,
  "--ro-bind": 2,
  "--bind": 2,
  "--tmpfs": 1,
  "--dev": 1,
  "--proc": 1,
} as const;

interface ShellWord {
  readonly value: string;
  readonly start: number;
}

/** Read the single-quoted argument format emitted by the sandbox runtime. */
function parseWrappedWords(command: string): ShellWord[] {
  const words: ShellWord[] = [];
  let index = 0;
  while (index < command.length) {
    if (command[index] === " ") {
      index++;
      continue;
    }
    const start = index;
    let value = "";
    while (index < command.length && command[index] !== " ") {
      const character = command[index];
      if (character === "'") {
        const end = command.indexOf("'", index + 1);
        if (end < 0) throw new Error("Linux sandbox wrapper has an unterminated argument");
        value += command.slice(index + 1, end);
        index = end + 1;
      } else if (command.startsWith('"\'"', index)) {
        value += "'";
        index += 3;
      } else {
        const match = /^[A-Za-z0-9_./:=@+,-]+/.exec(command.slice(index));
        if (!match) throw new Error("Linux sandbox wrapper has an unsupported argument encoding");
        value += match[0];
        index += match[0].length;
      }
    }
    words.push({ value, start });
  }
  return words;
}

function quoteShellWord(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

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

/**
 * A read-denied directory is a writable tmpfs in the Linux wrapper. Its
 * write-deny bind is skipped because the host directory is hidden, leaving the
 * child able to create files in that tmpfs. Remount a mask only when it is the
 * final mount at its exact target. A later write bind at that same target is an
 * intentional grant; a nested bind is a separate mount and stays writable.
 */
export function hardenLinuxSandboxWrap<T extends { readonly argv: string[]; readonly env: NodeJS.ProcessEnv }>(
  wrapped: T,
): T {
  if (wrapped.argv.length !== 3 || wrapped.argv[1] !== "-c") {
    throw new Error("Linux sandbox wrapper has an unexpected command shape");
  }
  const command = wrapped.argv[2];
  const words = parseWrappedWords(command);
  if (basename(words[0]?.value ?? "") !== "bwrap") {
    throw new Error("Linux sandbox wrapper does not invoke bubblewrap");
  }
  const maskedDirectories = new Map<string, string>();
  const finalMounts = new Map<string, "mask" | "write" | "read" | "special">();
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
  const remountTargets = [...maskedDirectories].filter(([identity]) => {
    const final = finalMounts.get(identity);
    if (final === "special") throw new Error("Linux sandbox wrapper replaces a mask with an unsupported mount");
    return final === "mask";
  }).map(([, path]) => path);
  if (remountTargets.length === 0) return wrapped;

  const remounts = remountTargets
    .flatMap((path) => ["--remount-ro", path])
    .map(quoteShellWord)
    .join(" ");
  const insertion = words[separator].start;
  return {
    ...wrapped,
    argv: [wrapped.argv[0], wrapped.argv[1], `${command.slice(0, insertion)}${remounts} ${command.slice(insertion)}`],
  };
}
