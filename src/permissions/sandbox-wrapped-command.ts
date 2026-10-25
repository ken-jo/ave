export interface SandboxWrappedWord {
  readonly value: string;
  readonly start: number;
}

/** Read the single-quoted argument format emitted by the sandbox runtime. */
export function parseSandboxWrappedWords(command: string, context = "Sandbox wrapper"): SandboxWrappedWord[] {
  const words: SandboxWrappedWord[] = [];
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
        if (end < 0) throw new Error(`${context} has an unterminated argument`);
        value += command.slice(index + 1, end);
        index = end + 1;
      } else if (command.startsWith('"\'"', index)) {
        value += "'";
        index += 3;
      } else {
        const match = /^[A-Za-z0-9_./:=@+,-]+/.exec(command.slice(index));
        if (!match) throw new Error(`${context} has an unsupported argument encoding`);
        value += match[0];
        index += match[0].length;
      }
    }
    words.push({ value, start });
  }
  return words;
}

export function quoteSandboxWrappedWord(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
