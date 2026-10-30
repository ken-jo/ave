import "../../__tests__/support/trusted-powershell.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ruleSpecifier from "../rules/rule-specifier.js";
import { analyzeShellForRules, proveLiteralShell } from "../rules/shell-rule-matcher.js";
import { globalOptionsEnd, parseShellCommand, stripGlobalOptions } from "../rules/shell-prefix-policy.js";
import { evaluatePowerShellSubject, evaluateShellSubject } from "../rules/rule-scopes.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { prepareShellFloorInput } from "../rules/shell-literal-data.js";

afterEach(() => vi.restoreAllMocks());

describe("request-owned shell rule analysis", () => {
  it("proves each raw word once and reuses its semantic and raw views", () => {
    const read = vi.spyOn(ruleSpecifier, "literalRuleWord");
    const parsed = parseShellCommand("echo 'literal text' plain");
    const first = analyzeShellForRules(parsed);
    const parentRawWords = ["echo", "'literal text'", "plain"];
    expect(read.mock.calls.filter(([raw, dialect]) => dialect === "bash" && parentRawWords.includes(raw))).toEqual([
      ["echo", "bash"], ["'literal text'", "bash"], ["plain", "bash"],
    ]);
    const proof = proveLiteralShell(parsed);
    expect(analyzeShellForRules(parsed)).toBe(first);
    expect(proof).toMatchObject({ proven: true });
    expect(first).toMatchObject({
      ok: true,
      commands: [{ argv: ["echo", "literal text", "plain"], rawWords: ["echo", "'literal text'", "plain"] }],
    });
    expect(read.mock.calls.filter(([, dialect]) => dialect === "bash").map(([raw]) => raw).sort())
      .toEqual([...parentRawWords, "literal", "text"].sort());
  });

  it.each(["bash", "powershell"] as const)("parses a repeated scoped %s rule once per evaluation", (dialect) => {
    const command = dialect === "bash" ? "printf 'literal text'" : "Write-Output 'literal text'";
    const pattern = `${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`;
    const deny = withCurrentShellRuleVersion({ pattern, action: "deny" as const });
    const allow = withCurrentShellRuleVersion({ pattern, action: "allow" as const });
    const read = vi.spyOn(ruleSpecifier, "parseRuleSpecifier");
    const decision = dialect === "bash"
      ? evaluateShellSubject({ command }, [deny, allow], [deny])
      : evaluatePowerShellSubject({ command, exactAllowOnly: true, floorSignal: null }, [deny, allow], [deny]);
    expect(decision).toMatchObject({ decision: "deny", pattern });
    expect(read.mock.calls.filter(([text]) => text === pattern)).toHaveLength(1);
  });

  it("skips verified body slices while mixed heredocs retain ordinary proof", () => {
    const read = vi.spyOn(ruleSpecifier, "literalRuleWord");
    const quoted = prepareShellFloorInput("cat <<'EOF'\nquoted-marker $value *\nEOF\n", "bash");
    expect(quoted?.literalDataBytes).toBeGreaterThan(0);
    expect(proveLiteralShell(quoted!.parsed!)).toMatchObject({ proven: false });
    expect(read.mock.calls.some(([raw]) => raw.includes("quoted-marker"))).toBe(false);
    read.mockClear();
    const mixed = prepareShellFloorInput("cat <<X <<'Y'\nplain-marker\nX\nquoted-marker\nY\n", "bash");
    expect(mixed?.literalDataBytes).toBe(0);
    expect(proveLiteralShell(mixed!.parsed!)).toMatchObject({ proven: false });
    expect(read.mock.calls.some(([raw]) => raw.includes("quoted-marker"))).toBe(true);
  });

  it("shares option suffixes without copying or repeatedly traversing argument tails", () => {
    const words = ["git", ...Array.from({ length: 256 }, (_, index) => index % 2 === 0 ? "-C" : "git"), "push"];
    let reads = 0;
    const argv = new Proxy(words, { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    } });
    const suffixes = new Map<string, Map<number, number>>();
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === "git") expect(globalOptionsEnd(argv, index, suffixes)).toBe(words.length - 1);
    }
    expect(reads).toBeLessThan(words.length * 10);
    expect(stripGlobalOptions(words)).toEqual(["git", "push"]);
  });

  it("keeps different option grammars independent in a shared command view", () => {
    const argv = ["git", "-C", "docker", "--host", "remote", "push"];
    const suffixes = new Map<string, Map<number, number>>();
    expect(globalOptionsEnd(argv, 0, suffixes)).toBe(4);
    expect(globalOptionsEnd(argv, 2, suffixes)).toBe(5);
    expect(stripGlobalOptions(["git", "-C"])).toEqual(["git"]);
  });
});
