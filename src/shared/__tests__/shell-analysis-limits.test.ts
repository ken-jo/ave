import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { analyzeShell, staticShellWord, type ShellAnalysis, type ShellCommand } from "../shell-analysis.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../shell-analysis-limits.js";
import { parseShellSyntax } from "../shell-parser.js";

const LIMITS = { totalTokens: MAX_SHELL_ANALYSIS_TOKENS };

function commands(result: ShellAnalysis): readonly ShellCommand[] {
  if (!result.ok || result.program.kind !== "sequence") throw new Error("Expected a parsed command list");
  return result.program.statements.filter((statement): statement is ShellCommand => statement.kind === "command");
}

describe("whole-input grammar token admission", () => {
  it("counts words across simple command boundaries before serialization", () => {
    const at = analyzeShell(":;".repeat(MAX_SHELL_ANALYSIS_TOKENS), "bash", LIMITS);
    expect(at.ok && at.totalTokens).toBe(MAX_SHELL_ANALYSIS_TOKENS);
    expect(analyzeShell(":;".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1), "bash", LIMITS)).toEqual({
      ok: false, reason: "Shell analysis total token limit exceeded",
    });
  });

  it("counts nested command and containing argument records together", () => {
    expect(analyzeShell("echo $(:)", "bash", LIMITS)).toMatchObject({ ok: true, totalTokens: 3 });
    expect(analyzeShell("echo $(printf x); ".repeat(257), "bash", LIMITS)).toEqual({
      ok: false, reason: "Shell analysis total token limit exceeded",
    });
  });

  it("retains assignment values without a per-command word refusal", () => {
    expect(analyzeShell("A=1;".repeat(400), "bash", LIMITS)).toMatchObject({ ok: true, totalTokens: 400 });
    expect(analyzeShell(`printf ${"x ".repeat(100)}`, "bash", LIMITS)).toMatchObject({ ok: true, totalTokens: 101 });
  });

  it("counts empty assignment records across the entire command", () => {
    expect(analyzeShell("A=;".repeat(MAX_SHELL_ANALYSIS_TOKENS), "bash", LIMITS)).toMatchObject({ ok: true, totalTokens: MAX_SHELL_ANALYSIS_TOKENS });
    expect(analyzeShell("A=;".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1), "bash", LIMITS)).toEqual({ ok: false, reason: "Shell analysis total token limit exceeded" });
  });

  it("counts naked declaration records even when they have no value word", () => {
    expect(analyzeShell("export A;".repeat(MAX_SHELL_ANALYSIS_TOKENS / 2), "bash", LIMITS)).toMatchObject({ ok: true, totalTokens: MAX_SHELL_ANALYSIS_TOKENS });
    expect(analyzeShell("export A;".repeat(MAX_SHELL_ANALYSIS_TOKENS / 2 + 1), "bash", LIMITS)).toEqual({ ok: false, reason: "Shell analysis total token limit exceeded" });
  });

  it("counts declaration command heads with no arguments", () => {
    expect(analyzeShell("export;".repeat(MAX_SHELL_ANALYSIS_TOKENS), "bash", LIMITS)).toMatchObject({ ok: true, totalTokens: MAX_SHELL_ANALYSIS_TOKENS });
    expect(analyzeShell("export;".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1), "bash", LIMITS)).toEqual({ ok: false, reason: "Shell analysis total token limit exceeded" });
  });

  it("counts a scalar assignment once whether its value is empty or present", () => {
    expect(analyzeShell("A= B=1 C='';", "bash", LIMITS)).toMatchObject({ ok: true, totalTokens: 3 });
    expect(analyzeShell("A=() B=(x y);", "bash", LIMITS)).toMatchObject({ ok: true, totalTokens: 4 });
    expect(analyzeShell("A=;".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1)).ok).toBe(true);
  });

  it("does not carry permission token limits into general parsing or later calls", () => {
    expect(analyzeShell(":;".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1), "bash", LIMITS).ok).toBe(false);
    expect(analyzeShell(":;".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1)).ok).toBe(true);
    expect(analyzeShell("echo ok", "bash", LIMITS)).toMatchObject({ ok: true, totalTokens: 2 });
  });
});

describe("native literal heredoc source slices", () => {
  it.each(["'EOF'", '"EOF"', "\\EOF", "E'OF'", "E\\OF"])("retains the physical body for delimiter %s", (delimiter) => {
    const body = "한글😀\nkeep\\\nphysical\n";
    const input = `echo 前; cat <<${delimiter}\n${body}EOF\necho 後`;
    const result = analyzeShell(input, "bash", LIMITS);
    const parsed = commands(result);
    const redirect = parsed[1]!.redirects[0]!;
    expect(redirect.heredocQuoted).toBe(true);
    expect(redirect.literalDataBytes).toBe(Buffer.byteLength(body));
    expect(redirect.data!.source.raw).toBe(body);
    expect(staticShellWord(redirect.data!)).toBe(body);
    expect(parsed[2]!.source.raw).toBe("echo 後");
    expect(result.ok && result.program.source.raw).toBe(input);
    expect(result.ok && result.totalTokens).toBe(6);
  });

  it("keeps physical tabs in the slice without changing general body payloads", () => {
    const input = "cat <<-'EOF'\n\tdata\n\tEOF\necho after";
    const limited = commands(analyzeShell(input, "bash", LIMITS));
    const general = commands(analyzeShell(input));
    expect(staticShellWord(limited[0]!.redirects[0]!.data!)).toBe("\tdata\n");
    expect(limited[0]!.redirects[0]!.literalDataBytes).toBe(6);
    expect(staticShellWord(general[0]!.redirects[0]!.data!)).toContain("data\n");
    expect(general[0]!.redirects[0]!.literalDataBytes).toBeUndefined();
    expect(limited[1]!.source.raw).toBe("echo after");
  });

  it("borrows multiple body ranges without serializing their literal payloads", () => {
    const first = "한".repeat(10_000) + "\n", second = "😀".repeat(5_000) + "\n";
    const input = `cat <<'X' <<'Y'\n${first}X\n${second}Y\necho end`;
    const syntax = parseShellSyntax(input, LIMITS);
    expect(JSON.stringify(syntax).length).toBeLessThan(8_000);
    const parsed = commands(analyzeShell(input, "bash", LIMITS));
    expect(parsed[0]!.redirects.map((redirect) => staticShellWord(redirect.data!))).toEqual([first, second]);
    expect(parsed[0]!.redirects.map((redirect) => redirect.literalDataBytes)).toEqual([Buffer.byteLength(first), Buffer.byteLength(second)]);
    expect(parsed[1]!.source.raw).toBe("echo end");
  });

  it("counts the exact data byte boundary without counting its spaces as words", () => {
    const body = "x ".repeat(32_767) + "x\n";
    const parsed = analyzeShell(`cat <<'EOF'\n${body}EOF\n`, "bash", LIMITS);
    expect(parsed.ok && parsed.totalTokens).toBe(2);
    expect(commands(parsed)[0]!.redirects[0]!.literalDataBytes).toBe(65_536);
  });
});

const wireCases = JSON.parse(readFileSync(new URL("./fixtures/shell-syntax-wire.json", import.meta.url), "utf8")) as readonly { source: string; limited: boolean; sha256: string }[];

describe("complete grammar wire fields", () => {
  it.each(wireCases)("retains every serialized field for $source", ({ source, limited, sha256 }) => {
    const tree = parseShellSyntax(source, limited ? LIMITS : undefined);
    expect(createHash("sha256").update(JSON.stringify(tree)).digest("hex")).toBe(sha256);
  });
});

describe("pipeline lowering", () => {
  it.each([32, 100, 120])("visits a %i-stage pipeline without copying accumulated statements", (stages) => {
    const source = Array.from({ length: stages }, () => "printf x").join(" | ");
    const original = Array.prototype[Symbol.iterator];
    let copiedStatements = 0;
    let parsed: ShellAnalysis;
    Array.prototype[Symbol.iterator] = (function* (this: unknown[]) {
      const first = this[0];
      const statements = first !== null && typeof first === "object" && "kind" in first
        && ["command", "pipeline", "sequence", "subshell", "redirected", "negate", "background"].includes(String(first.kind));
      for (const item of original.call(this)) {
        if (statements) copiedStatements += 1;
        yield item;
      }
    }) as typeof original;
    try {
      parsed = analyzeShell(source, "bash", LIMITS);
    } finally {
      Array.prototype[Symbol.iterator] = original;
    }
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.program.kind !== "sequence") throw new Error("Expected the original parsed pipeline");
    const pipeline = parsed.program.statements[0]!;
    expect(pipeline.kind).toBe("pipeline");
    if (pipeline.kind !== "pipeline") throw new Error("Expected a pipeline");
    expect(pipeline.statements).toHaveLength(stages);
    expect(pipeline.source.raw).toBe(source);
    expect(copiedStatements).toBeLessThanOrEqual(stages * 4);
  });

  it("preserves group and redirect boundaries inside pipelines", () => {
    const result = analyzeShell("printf a | (printf b | cat) | cat > out", "bash", LIMITS);
    if (!result.ok || result.program.kind !== "sequence") throw new Error("Expected a command list");
    const pipeline = result.program.statements[0]!;
    if (pipeline.kind !== "pipeline") throw new Error("Expected a pipeline");
    expect(pipeline.statements.map((stage) => stage.kind)).toEqual(["command", "subshell", "command"]);
    const tail = pipeline.statements[2]!;
    if (tail.kind !== "command") throw new Error("Expected the redirected final command");
    expect(tail.redirects).toHaveLength(1);
  });

  it.each(["! printf a | cat", "printf a | cat &"])("preserves execution wrappers for %s", (source) => {
    const result = analyzeShell(source, "bash", LIMITS);
    if (!result.ok || result.program.kind !== "sequence") throw new Error("Expected a command list");
    const wrapped = result.program.statements[0]!;
    expect(wrapped.kind).toBe(source.startsWith("!") ? "negate" : "background");
    if (wrapped.kind !== "negate" && wrapped.kind !== "background") throw new Error("Expected an execution wrapper");
    expect(wrapped.body.kind).toBe("pipeline");
  });
});

describe("permission position representation", () => {
  it("omits only unused diagnostic coordinates and keeps every original offset", () => {
    const source = "printf 한글\nprintf 😀";
    const general = parseShellSyntax(source);
    const limited = parseShellSyntax(source, LIMITS);
    expect(limited.Pos).toEqual({ Offset: 0 });
    expect(limited.End).toEqual({ Offset: Buffer.byteLength(source) });
    expect(general.Pos).toMatchObject({ Offset: 0, Line: 1, Col: 1 });
    expect(parseShellSyntax(source)).toEqual(general);
  });

  it("preserves semantic words, quote spelling and qualified program identity", () => {
    const source = String.raw`'Alpha\Invoke-Probe' '-Force' '0x10' "msg"`;
    const general = analyzeShell(source);
    const limited = analyzeShell(source, "bash", LIMITS);
    expect(limited).toEqual(general);
    expect(commands(limited)[0]!.words.map((word) => word.source.raw)).toEqual([
      String.raw`'Alpha\Invoke-Probe'`, "'-Force'", "'0x10'", '"msg"',
    ]);
  });
});
