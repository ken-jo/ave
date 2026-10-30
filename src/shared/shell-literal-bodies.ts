import { classifySedArgumentSlots } from "./shell-sed-arguments.js";
import { classifySqliteArgumentSlots } from "../tools/shell-sqlite-arguments.js";
import { wrapperCommand } from "../permissions/rules/shell-prefix-policy.js";
import { isEncodedPowerShellParameter } from "../permissions/rules/powershell-encoded-command.js";

interface LiteralShellBody {
  text: string;
  dialect: "bash" | "posix" | "powershell";
  index: number;
}

export type LiteralShellArgument = string | readonly string[] | undefined;

function executableName(value: string): string {
  return value.split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.exe$/u, "");
}

/** Select executable literal bodies from parser-owned argv; this never evaluates or tokenizes source. */
export function literalShellBodies(
  argv: readonly LiteralShellArgument[], dialect: "bash" | "posix" | "powershell", raw?: readonly string[], stdin?: string,
): readonly LiteralShellBody[] {
  const head = argv[0];
  if (typeof head !== "string") return [];
  const name = dialect === "powershell" || process.platform === "win32" ? executableName(head) : head.split("/").at(-1)!.replace(/\.exe$/u, "");
  const strings = (values: readonly LiteralShellArgument[]): string[] | undefined => {
    const result: string[] = [];
    for (const value of values) {
      if (value === undefined) return undefined;
      if (typeof value === "string") result.push(value);
      else result.push(...value);
    }
    return result;
  };
  if (["sed", "sqlite3"].includes(name)) {
    const values = strings(argv);
    if (values) {
      const slots = name === "sed" ? classifySedArgumentSlots(values) : classifySqliteArgumentSlots(values);
      return slots.nestedCommands.map(body => ({ text: body.value, index: body.index, dialect: "posix" as const }));
    }
  }
  if (dialect !== "powershell" && head === "exec" && argv.every((value): value is string => typeof value === "string")) {
    const child = wrapperCommand(argv);
    if (!child.ordinaryAsk && !child.runtimeArgv && !child.code && child.index > 0 && child.index < argv.length) {
      return literalShellBodies(argv.slice(child.index), dialect, raw?.slice(child.index))
        .map(body => ({ ...body, index: body.index + child.index }));
    }
  }
  if (dialect !== "powershell" && head === "eval") {
    const start = argv[1] === "--" ? 2 : 1;
    const values = strings(argv.slice(start));
    return values?.length ? [{ text: values.join(" "), dialect, index: start }] : [];
  }
  if (dialect === "powershell" && ["iex", "invoke-expression"].includes(name)) {
    const start = typeof argv[1] === "string" && /^-command$/iu.test(argv[1]) ? 2 : 1;
    return typeof argv[start] === "string" && argv.length === start + 1
      ? [{ text: argv[start], dialect, index: start }] : [];
  }
  if (dialect === "powershell" && ["start-process", "start"].includes(name)) {
    let executable: string | undefined;
    let argumentValues: string[] | undefined;
    let argumentIndex = 0;
    for (let index = 1; index < argv.length; index++) {
      const value = argv[index];
      if (typeof value !== "string") continue;
      const parameter = !/^["']/u.test(raw?.[index] ?? "") ? /^[-\u2013-\u2015](filepath|argumentlist)(?::(.*))?$/iu.exec(value) : null;
      if (parameter) {
        const inline = parameter[2];
        if (parameter[1]!.toLowerCase() === "filepath") {
          const target = inline || argv[++index];
          if (typeof target === "string") executable = target;
        } else {
          argumentIndex = inline ? index : index + 1;
          const values: LiteralShellArgument[] = inline ? [inline] : [];
          while (index + 1 < argv.length) {
            const next = argv[index + 1];
            if (typeof next === "string" && /^[-\u2013-\u2015][A-Za-z]/u.test(next)
              && !/^["']/u.test(raw?.[index + 1] ?? "")) break;
            index++;
            if (next !== ",") values.push(next);
          }
          argumentValues = strings(values);
        }
      } else if (executable === undefined && !value.startsWith("-")) executable = value;
    }
    if (!executable || !argumentValues) return [];
    const nested = literalShellBodies([executable, ...argumentValues], "powershell");
    const executableText = /[\s'"]/u.test(executable) ? "& '" + executable.replaceAll("'", "''") + "'" : executable;
    return nested.length ? nested.map(body => ({ ...body, index: argumentIndex }))
      : [{ text: [executableText, ...argumentValues].join(" "), dialect: "powershell", index: argumentIndex }];
  }
  const shell = ["sh", "dash", "bash", "zsh", "ksh"].includes(name);
  const powerShell = ["pwsh", "powershell"].includes(name);
  const commandShell = name === "cmd";
  if (!shell && !powerShell && !commandShell) return [];
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index];
    if (typeof value !== "string") continue;
    if (powerShell && isEncodedPowerShellParameter(value)) return [];
    const shellOption = shell ? /^-[A-Za-z]*?c([\s\S]*)$/u.exec(value) : null;
    const command = shell ? shellOption !== null : commandShell ? /^\/(?:c|k)$/iu.test(value) : /^-(?:c|command)$/iu.test(value);
    if (!command) continue;
    if (shellOption?.[1]) return [{ text: shellOption[1], dialect: name === "bash" ? "bash" : "posix", index }];
    const start = index + 1;
    const values = strings(powerShell || commandShell ? argv.slice(start) : argv.slice(start, start + 1));
    return values?.length ? [{ text: values.join(" "), dialect: powerShell || commandShell ? "powershell" : name === "bash" ? "bash" : "posix", index: start }] : [];
  }
  const stdinSelected = argv.length === 1 || argv[1] === "-"
    || argv.slice(1).some(value => typeof value === "string" && /^-[A-Za-z]*s[A-Za-z]*$/u.test(value))
    || argv.slice(1).every(value => typeof value === "string" && value.startsWith("-"));
  return shell && stdin !== undefined && stdinSelected
    ? [{ text: stdin, dialect: name === "bash" ? "bash" : "posix", index: argv.length }]
    : [];
}

export interface LiteralBodyBudget { tokens: { count: number }; depth: number }

interface LiteralShellFlow { network: boolean; readsPath: boolean }
const literalFlows = new WeakMap<object, LiteralShellFlow>();

/** Keep typed child flow in memory without adding execution authority or serialized signal fields. */
export function recordLiteralShellFlow<T extends object>(result: T, flow: LiteralShellFlow): T {
  literalFlows.set(result, flow);
  return result;
}

export function literalShellFlow(result: object): LiteralShellFlow | undefined { return literalFlows.get(result); }
