import { basename } from "node:path";

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

/**
 * A read-denied directory is a writable tmpfs in the Linux wrapper. Its
 * write-deny bind is skipped because the host directory is hidden, leaving the
 * child able to create files in that tmpfs. Remount each such mask read-only
 * after the runtime's binds. A nested write bind remains a separate mount and
 * keeps the plugin's own storage writable.
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
  const separator = words.findIndex((word, index) =>
    word.value === "--" && index + 4 === words.length && words[index + 2]?.value === "-c");
  if (separator < 0) throw new Error("Linux sandbox wrapper has no command separator");

  const maskedDirectories = new Set<string>();
  for (let index = 1; index < separator; index++) {
    if (words[index].value !== "--tmpfs") continue;
    const path = words[++index]?.value;
    if (!path?.startsWith("/")) throw new Error("Linux sandbox wrapper has an invalid tmpfs target");
    maskedDirectories.add(path);
  }
  if (maskedDirectories.size === 0) return wrapped;

  const remounts = [...maskedDirectories]
    .flatMap((path) => ["--remount-ro", path])
    .map(quoteShellWord)
    .join(" ");
  const insertion = words[separator].start;
  return {
    ...wrapped,
    argv: [wrapped.argv[0], wrapped.argv[1], `${command.slice(0, insertion)}${remounts} ${command.slice(insertion)}`],
  };
}
