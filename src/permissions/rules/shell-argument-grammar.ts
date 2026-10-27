import { canonicalPowerShellName, POWERSHELL_COMMAND_POLICIES } from "./powershell-command-policy.js";
import { encodedPowerShellExecutionReason } from "./powershell-encoded-command.js";

export type StaticArgvProof =
  | { kind: "unproven" }
  | { kind: "static-complete"; changesState: boolean; dataOnly?: true }
  | { kind: "literal-evaluation"; payloadIndexes: readonly number[]; changesState: false };

export interface StaticArgvWork { staticTokens: number; staticChars: number }
interface ArgumentGrammar {
  flags?: readonly string[];
  values?: readonly string[];
  optionalValues?: readonly string[];
  configuration?: { disabledByFirstArgument: readonly string[] };
  minimum?: number;
  maximum?: number;
  changesState?: boolean;
  required?: readonly (readonly string[])[];
}

const UNPROVEN: StaticArgvProof = Object.freeze({ kind: "unproven" });
const PATH_FLAGS = ["-r", "-R", "-f", "-i", "-n", "-v", "-p", "-P", "-L", "-H", "--recursive", "--force", "--verbose", "--no-clobber"];
const NATIVE_GRAMMARS: Readonly<Record<string, ArgumentGrammar>> = Object.freeze({
  ":": { maximum: 0 }, true: { maximum: 0 }, false: { maximum: 0 },
  pwd: { flags: ["-L", "-P"], maximum: 0 },
  cd: { flags: ["-L", "-P"], maximum: 1, changesState: true },
  cat: { flags: ["-A", "-b", "-e", "-E", "-n", "-s", "-t", "-T", "-u", "-v", "--number", "--show-all"] },
  wc: { flags: ["-c", "-m", "-l", "-w", "-L", "--bytes", "--chars", "--lines", "--words"] },
  head: { flags: ["-q", "-v"], values: ["-n", "-c", "--lines", "--bytes"] },
  tail: { flags: ["-q", "-v", "-f", "-F"], values: ["-n", "-c", "--lines", "--bytes"] },
  base64: { flags: ["-d", "-D", "-i", "--decode", "--ignore-garbage"], values: ["-w", "--wrap"] },
  base32: { flags: ["-d", "--decode", "--ignore-garbage"], values: ["-w", "--wrap"] },
  ls: { flags: ["-a", "-A", "-l", "-h", "-R", "-L", "-P", "-d", "-t", "-r", "-S", "-1", "--all", "--recursive"], values: ["--sort"], optionalValues: ["--color"] },
  grep: { flags: ["-i", "-v", "-n", "-l", "-L", "-r", "-R", "-h", "-H", "-q", "-F", "-E", "-P", "-w", "-x", "--recursive", "--dereference-recursive"], values: ["-e", "-f", "-m", "-A", "-B", "-C", "--regexp", "--file"], required: [["#0", "-e", "--regexp", "-f", "--file"]] },
  rg: { flags: ["-i", "-s", "-S", "-v", "-n", "-l", "-L", "-q", "-F", "-w", "-x", "-u", "--files", "--hidden", "--follow", "--no-ignore", "--line-number", "--files-with-matches"], values: ["-r", "-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "--glob", "--iglob", "--type", "--regexp", "--file"], required: [["#0", "-e", "--regexp", "-f", "--file", "--files"]] },
  sort: { flags: ["-r", "-n", "-u", "-f", "-b", "-h"], values: ["-k", "-t", "-o"], changesState: true },
  uniq: { flags: ["-c", "-d", "-u", "-i"], values: ["-f", "-s", "-w"], maximum: 2, changesState: true },
  cut: { flags: ["-s", "--complement"], values: ["-b", "-c", "-f", "-d", "--bytes", "--characters", "--fields", "--delimiter"], required: [["-b", "--bytes", "-c", "--characters", "-f", "--fields"]] },
  cp: { flags: PATH_FLAGS, values: ["-t", "--target-directory"], minimum: 2, changesState: true },
  mv: { flags: PATH_FLAGS, values: ["-t", "--target-directory"], minimum: 2, changesState: true },
  ln: { flags: [...PATH_FLAGS, "-s", "--symbolic"], minimum: 1, changesState: true },
  mkdir: { flags: ["-p", "-v", "--parents", "--verbose"], values: ["-m", "--mode"], minimum: 1, changesState: true },
  touch: { flags: ["-a", "-m", "-c", "-h"], values: ["-r", "-t", "-d"], minimum: 1, changesState: true },
  tee: { flags: ["-a", "-i", "--append"], changesState: true },
  rm: { flags: ["-r", "-R", "-f", "-i", "-v", "-d", "--recursive", "--force"], minimum: 1, changesState: true },
  curl: { configuration: { disabledByFirstArgument: ["-q", "--disable"] }, flags: ["-s", "-S", "-f", "-L", "-k", "-v", "-i", "-I", "-N", "-q", "-g", "--disable", "--silent", "--show-error", "--fail", "--location", "--insecure", "--head"], values: ["-X", "-H", "-d", "-F", "-T", "-o", "-u", "-w", "--request", "--header", "--proxy-header", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "--form", "--upload-file", "--output", "--user", "--write-out", "--url", "--proxy", "--connect-timeout", "--max-time"], minimum: 1, changesState: true },
});
interface CmdletGrammar extends ArgumentGrammar { numeric?: readonly string[] }
const POWERSHELL_GRAMMARS: Readonly<Record<string, CmdletGrammar>> = Object.freeze({
  "write-output": { flags: ["noenumerate"], values: ["inputobject"] },
  "write-host": { flags: ["nonewline"], values: ["separator", "foregroundcolor", "backgroundcolor", "object"] },
  "select-object": { flags: ["unique", "wait"], values: ["property", "expandproperty", "first", "last", "skip", "skiplast"], numeric: ["first", "last", "skip", "skiplast"] },
  "out-string": { flags: ["stream"], values: ["width", "inputobject"], numeric: ["width"], maximum: 0 },
  "get-date": { values: ["format", "uformat", "date"], maximum: 1 },
  "get-location": { maximum: 0 },
  "get-content": { flags: ["raw", "force", "wait"], values: ["path", "literalpath", "encoding", "tail", "totalcount"], numeric: ["tail", "totalcount"], required: [["path", "literalpath", "#0"]] },
  "get-childitem": { flags: ["recurse", "force", "file", "directory", "hidden", "name"], values: ["path", "literalpath", "filter", "include", "exclude", "depth"], numeric: ["depth"] },
  "test-path": { flags: ["isvalid"], values: ["path", "literalpath", "pathtype"], maximum: 1, required: [["path", "literalpath", "#0"]] },
  "select-string": { flags: ["simplematch", "casesensitive", "quiet", "list", "notmatch", "allmatches"], values: ["pattern", "path", "literalpath", "encoding"], required: [["pattern", "#0"]] },
  "set-content": { flags: ["force", "nonewline", "passthru"], values: ["path", "literalpath", "value", "encoding"], minimum: 0, maximum: 2, changesState: true, required: [["path", "literalpath", "#0"], ["value", "#1"]] },
  "add-content": { flags: ["force", "nonewline", "passthru"], values: ["path", "literalpath", "value", "encoding"], maximum: 2, changesState: true, required: [["path", "literalpath", "#0"], ["value", "#1"]] },
  "out-file": { flags: ["append", "force", "noclobber", "nonewline"], values: ["filepath", "literalpath", "encoding", "width", "inputobject"], maximum: 1, changesState: true, required: [["filepath", "literalpath", "#0"]] },
  "copy-item": { flags: ["recurse", "force", "passthru"], values: ["path", "literalpath", "destination"], maximum: 2, changesState: true, required: [["path", "literalpath", "#0"]] },
  "move-item": { flags: ["force", "passthru"], values: ["path", "literalpath", "destination"], maximum: 2, changesState: true, required: [["path", "literalpath", "#0"]] },
  "remove-item": { flags: ["recurse", "force"], values: ["path", "literalpath"], changesState: true, required: [["path", "literalpath", "#0"]] },
  "set-location": { flags: ["passthru"], values: ["path", "literalpath"], maximum: 1, changesState: true },
  "invoke-webrequest": { flags: ["usebasicparsing"], values: ["uri", "method", "infile", "body", "outfile", "contenttype", "timeoutsec"], numeric: ["timeoutsec"], maximum: 1, required: [["uri", "#0"]] },
  "invoke-restmethod": { flags: ["usebasicparsing"], values: ["uri", "method", "infile", "body", "outfile", "contenttype", "timeoutsec"], numeric: ["timeoutsec"], maximum: 1, required: [["uri", "#0"]] },
});
const BASH_BUILTINS = new Set([":", "true", "false", "pwd", "cd", "printf", "echo", "eval"]);

function matchArgumentGrammar(argv: readonly (string | undefined)[], from: number, grammar: ArgumentGrammar, powershell: boolean, raw?: readonly string[], work?: StaticArgvWork): boolean {
  const read = (index: number): string | undefined => {
    const value = argv[index];
    if (work !== undefined) { work.staticTokens += 1; work.staticChars += value?.length ?? 0; }
    return value;
  };
  // Configuration-dependent grammars require an argv proof at the child boundary.
  if (grammar.configuration !== undefined
    && !grammar.configuration.disabledByFirstArgument.includes(read(from) ?? "")) return false;
  const isQuoted = (index: number): boolean => /^["']/.test(raw?.[index] ?? "");
  const isParameter = (index: number, value: string): boolean => !isQuoted(index) && /^\p{Pd}/u.test(value);
  let positions = 0, data = false;
  const present = new Set<string>();
  const flags = new Set(grammar.flags ?? []), values = new Set(grammar.values ?? []), optionalValues = new Set(grammar.optionalValues ?? []);
  for (let index = from; index < argv.length; index += 1) {
    const token = read(index);
    if (token === undefined) return false;
    if (powershell && !isQuoted(index) && /^\p{Pd}/u.test(token) && !token.startsWith("-")) return false;
    if (!powershell && token === "--" && !data) { data = true; continue; }
    if (data || token === "-" || !token.startsWith("-") || (powershell && isQuoted(index))) { present.add(`#${positions++}`); continue; }
    if (powershell) {
      const match = /^-([A-Za-z][A-Za-z0-9]*)(?::(.*))?$/.exec(token);
      if (match === null) return false;
      const name = match[1]!.toLowerCase(), attached = match[2];
      if (flags.has(name)) { if (attached !== undefined && attached !== "$true" && attached !== "$false") return false; continue; }
      if (!values.has(name)) return false;
      present.add(name);
      const value = attached ?? read(++index);
      if (value === undefined || (attached === undefined && isParameter(index, value) && !/^-?\d+$/.test(value))) return false;
      if ((grammar as CmdletGrammar).numeric?.includes(name) && !/^-?\d+$/.test(value)) return false;
      continue;
    }
    const equal = token.indexOf("="), flag = equal < 0 ? token : token.slice(0, equal);
    if (flags.has(flag)) { present.add(flag); if (equal >= 0) return false; continue; }
    if (optionalValues.has(flag)) { present.add(flag); continue; }
    if (values.has(flag)) { present.add(flag); if (equal < 0 && read(++index) === undefined) return false; continue; }
    if (token.startsWith("--")) return false;
    let accepted = token.length > 1;
    for (let offset = 1; offset < token.length; offset += 1) {
      const short = `-${token[offset]}`;
      if (optionalValues.has(short)) { present.add(short); break; }
      if (values.has(short)) { present.add(short); if (offset + 1 === token.length && read(++index) === undefined) return false; break; }
      if (!flags.has(short)) { accepted = false; break; }
      present.add(short);
    }
    if (!accepted) return false;
  }
  return positions >= (grammar.minimum ?? 0) && positions <= (grammar.maximum ?? Number.POSITIVE_INFINITY)
    && (grammar.required?.every((group) => group.some((name) => present.has(name))) ?? true);
}

export function proveStaticArgv(argv: readonly (string | undefined)[], dialect: "bash" | "powershell", raw?: readonly string[], work?: StaticArgvWork): StaticArgvProof {
  const read = (index: number): string | undefined => {
    const value = argv[index];
    if (work !== undefined) { work.staticTokens += 1; work.staticChars += value?.length ?? 0; }
    return value;
  };
  const complete = (changesState = false): StaticArgvProof => ({ kind: "static-complete", changesState });
  const evaluation = (indexes: readonly number[]): StaticArgvProof => ({ kind: "literal-evaluation", payloadIndexes: indexes, changesState: false });
  if (argv.length === 0) return UNPROVEN;
  for (let index = 0; index < argv.length; index += 1) {
    if (read(index) === undefined) return UNPROVEN;
  }
  if (encodedPowerShellExecutionReason(argv, raw) !== null) return UNPROVEN;
  const isQuoted = (index: number): boolean => /^["']/.test(raw?.[index] ?? "");
  const isParameter = (index: number, value: string): boolean => !isQuoted(index) && /^\p{Pd}/u.test(value);
  const matchesOptions = (from: number, grammar: ArgumentGrammar, powershell = false): boolean =>
    matchArgumentGrammar(argv, from, grammar, powershell, raw, work);
  function program(token: string): string | undefined {
    if (/[\/\\]/.test(token)) return undefined;
    return process.platform === "win32" ? token.toLowerCase().replace(/\.exe$/, "") : token;
  }
  let at = 0;
  let resolution: "bash-command" | "powershell-command" | "native-executable" = dialect === "bash" ? "bash-command" : "powershell-command";
  while (at < argv.length) {
    const original = read(at)!;
    const name = program(original);
    const psName = canonicalPowerShellName(original);
    if (resolution === "powershell-command") {
      const qualified = original.includes("\\");
      const knownQualification = !qualified || /^Microsoft\.PowerShell\.(?:Utility|Management)\\/i.test(original);
      if (!original.includes("/") && knownQualification) {
        if (psName === "invoke-expression") {
          const count = argv.length - at;
          if (count === 2 && !isParameter(at + 1, read(at + 1)!)) return evaluation([at + 1]);
          if (count === 3 && read(at + 1)!.toLowerCase() === "-command" && !isParameter(at + 2, read(at + 2)!)) return evaluation([at + 2]);
          return UNPROVEN;
        }
        const grammar = Object.hasOwn(POWERSHELL_GRAMMARS, psName) ? POWERSHELL_GRAMMARS[psName] : undefined;
        if (grammar !== undefined) {
          // Across editions an alias may instead resolve to a known native program.
          // Both grammars must prove the same argv; detection keeps the alias union.
          let nativeChangesState = false;
          const aliasName = name?.toLowerCase();
          if (aliasName !== undefined && psName !== aliasName
            && (Object.hasOwn(NATIVE_GRAMMARS, aliasName) || POWERSHELL_COMMAND_POLICIES[`${aliasName}.exe`]?.native !== undefined)) {
            const nativeGrammar = NATIVE_GRAMMARS[aliasName];
            if (nativeGrammar === undefined || !matchesOptions(at + 1, nativeGrammar)) return UNPROVEN;
            nativeChangesState = nativeGrammar.changesState === true;
          }
          if (!matchesOptions(at + 1, grammar, true)) return UNPROVEN;
          const output = psName === "invoke-webrequest" || psName === "invoke-restmethod";
          const writes = output && argv.some((value) => /^-outfile(?::|$)/i.test(value ?? ""));
          return complete(grammar.changesState === true || nativeChangesState || writes);
        }
      }
      if (psName !== name && POWERSHELL_COMMAND_POLICIES[psName]?.native === undefined) return UNPROVEN;
    }
    if (name === undefined) return UNPROVEN;
    if (name === "env" || name === "command" || name === "exec" || name === "builtin") {
      if (name !== "env" && resolution !== "bash-command") return UNPROVEN;
      if (read(at + 1) === "--") at += 1;
      const next = read(++at);
      if (next === undefined || next.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) return UNPROVEN;
      if (name === "builtin" && !BASH_BUILTINS.has(next)) return UNPROVEN;
      if (name === "env" || name === "exec") resolution = "native-executable";
      continue;
    }
    if (name === "printf") {
      let format = at + 1;
      if (read(format) === "--") format += 1;
      const text = read(format);
      if (text === undefined || text.startsWith("-")) return UNPROVEN;
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== "%") continue;
        index += 1;
        if (text[index] === "%") continue;
        while (index < text.length && "#0- +'.0123456789".includes(text[index]!)) index += 1;
        if (index >= text.length || !"sqbdiouxXeEfFgGc".includes(text[index]!)) return UNPROVEN;
      }
      return { kind: "static-complete", changesState: false, dataOnly: true };
    }
    if (name === "echo") {
      let cursor = at + 1;
      while (read(cursor)?.startsWith("-")) {
        if (!/^-[nEe]+$/.test(read(cursor)!)) return UNPROVEN;
        cursor += 1;
      }
      return { kind: "static-complete", changesState: false, dataOnly: true };
    }
    if (name === "cd" && read(at + 1) === "-") return UNPROVEN;
    if ((name === "cd" || name === ":") && resolution !== "bash-command") return UNPROVEN;
    if (name === "eval") {
      if (resolution !== "bash-command") return UNPROVEN;
      if (at + 1 >= argv.length || read(at + 1)!.startsWith("-")) return UNPROVEN;
      return evaluation(Array.from({ length: argv.length - at - 1 }, (_, index) => at + 1 + index));
    }
    // No child interpreter has a registered grammar: argv cannot prove the
    // resolved installation or its adjacent and inherited startup inputs.
    const grammar = Object.hasOwn(NATIVE_GRAMMARS, name) ? NATIVE_GRAMMARS[name] : undefined;
    if (grammar === undefined || !matchesOptions(at + 1, grammar)) return UNPROVEN;
    return complete(grammar.changesState === true);
  }
  return UNPROVEN;
}

export function _proveStaticArgvForTest(argv: readonly (string | undefined)[], dialect: "bash" | "powershell", raw?: readonly string[]): { proof: StaticArgvProof; work: StaticArgvWork } {
  const work = { staticTokens: 0, staticChars: 0 };
  return { proof: proveStaticArgv(argv, dialect, raw, work), work };
}

export function _argumentGrammarsForTest(): readonly { command: readonly string[]; grammar: ArgumentGrammar }[] {
  return [NATIVE_GRAMMARS, POWERSHELL_GRAMMARS].flatMap((table) =>
    Object.entries(table).map(([program, grammar]) => ({ command: [program], grammar })));
}

export function _matchArgumentGrammarForTest(argv: readonly string[], grammar: ArgumentGrammar): boolean {
  return matchArgumentGrammar(argv, 0, grammar, false);
}
