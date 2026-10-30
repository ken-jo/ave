import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as shellAnalysis from "../shell-analysis.js";
import { bindShellSyntaxSnapshot, existingStaticShellSyntax, shellSyntaxObservation } from "../shell-syntax-cache.js";
import { parseShellFloorCommand } from "../../permissions/rules/shell-exfiltration.js";
import { inspectPosixShellPermissionPaths } from "../../tools/shell-path-policy.js";

import { bindVerifiedArgvProof, verifiedArgvProof } from "../../permissions/rules/verified-argv-authority.js";

import { PermissionManager } from "../../permissions/permission-manager.js";

const COMMAND = "printf '%s' 'literal body text'";

describe("request-owned shell syntax observations", () => {
  it.each([new Error("Literal parser unavailable"), undefined])("preserves cached parser failure semantics: %s", parserError => {
    const parse = vi.spyOn(shellAnalysis, "analyzeShell").mockImplementation(() => { throw parserError; });
    try {
      const counter = { count: 0 };
      const observation = shellSyntaxObservation(COMMAND, "bash", { totalTokens: 400 }, counter);
      expect("parserError" in observation).toBe(true);
      expect(observation.parserError).toBe(parserError);
      let threw = false, caught: unknown;
      try { inspectPosixShellPermissionPaths(COMMAND, process.cwd(), { dialect: "bash", environment: {} }, undefined, { tokens: counter, depth: 0 }); }
      catch (error) { threw = true; caught = error; }
      expect(threw).toBe(true);
      expect(caught).toBe(parserError);
      expect(parseShellFloorCommand(COMMAND, 8_000, counter)).toMatchObject({ analysis: { ok: false, reason: "shell parser failed" } });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally { parse.mockRestore(); }
  });

  it("shares pure syntax across independent counters without sharing consumer facts", () => {
    const owner = {}, floorCounter = {}, pathCounter = {};
    bindShellSyntaxSnapshot(owner, floorCounter);
    bindShellSyntaxSnapshot(owner, pathCounter);
    const floor = parseShellFloorCommand(COMMAND, 8_000, floorCounter);
    const path = parseShellFloorCommand(COMMAND, 8_000, pathCounter);
    expect(path.analysis).toBe(floor.analysis);
    expect(path).not.toBe(floor);
    expect(path.facts).not.toBe(floor.facts);
    floor.facts.set("consumer-observation", "not shared");
    expect(path.facts.has("consumer-observation")).toBe(false);
  });

  it("uses a verified root only as an owner, never as cached child syntax", () => {
    const root = parseShellFloorCommand(COMMAND);
    if (!root.analysis.ok) throw new Error("Expected root syntax");
    const rootCommand = root.analysis.program.kind === "sequence" ? root.analysis.program.statements[0]! : root.analysis.program;
    bindVerifiedArgvProof(rootCommand, { kind: "static-complete", changesState: false });
    const counter = {};
    bindShellSyntaxSnapshot(root, counter);
    const child = shellSyntaxObservation(COMMAND, "bash", { totalTokens: 400 }, counter);
    if (!child.analysis.ok) throw new Error("Expected child syntax");
    const childCommand = child.analysis.program.kind === "sequence" ? child.analysis.program.statements[0]! : child.analysis.program;
    expect(childCommand).not.toBe(rootCommand);
    expect(verifiedArgvProof(childCommand)).toBeUndefined();
    expect(existingStaticShellSyntax(COMMAND, ["printf", "%s", "literal body text"], { totalTokens: 400 }, counter)?.analysis).toBe(child.analysis);
    expect(verifiedArgvProof(rootCommand)).toMatchObject({ kind: "static-complete" });
  });

  it("does not reuse syntax between request owners, dialects or parser limits", () => {
    const first = {}, second = {};
    bindShellSyntaxSnapshot({}, first);
    bindShellSyntaxSnapshot({}, second);
    const a = shellSyntaxObservation(COMMAND, "bash", { totalTokens: 400 }, first);
    expect(shellSyntaxObservation(COMMAND, "bash", { totalTokens: 400 }, first)).toBe(a);
    expect(shellSyntaxObservation(COMMAND, "bash", { totalTokens: 400 }, second)).not.toBe(a);
    expect(shellSyntaxObservation(COMMAND, "posix", { totalTokens: 400 }, first)).not.toBe(a);
    const bounded = shellSyntaxObservation(COMMAND, "bash", { totalTokens: 1 }, first);
    expect(bounded).not.toBe(a);
    expect(bounded.analysis.ok).toBe(false);
    expect(a.analysis.ok).toBe(true);
  });

  it("retains original literal source extents and token counts on a cache hit", () => {
    const owner = {}, a = {}, b = {};
    bindShellSyntaxSnapshot(owner, a); bindShellSyntaxSnapshot(owner, b);
    const first = shellSyntaxObservation(COMMAND, "bash", { totalTokens: 400 }, a);
    const second = shellSyntaxObservation(COMMAND, "bash", { totalTokens: 400 }, b);
    expect(second.analysis).toEqual(first.analysis);
    if (!second.analysis.ok) throw new Error("Expected bounded syntax");
    expect(second.analysis.totalTokens).toBe(3);
    const command = second.analysis.program.kind === "sequence" ? second.analysis.program.statements[0]! : second.analysis.program;
    if (command.kind !== "command") throw new Error("Expected command syntax");
    expect(command.words.map(word => word.source.raw)).toEqual(["printf", "'%s'", "'literal body text'"]);
    expect(command.source.raw).toBe(COMMAND);
  });
});


describe("original static native syntax projection", () => {
  it("peeks eligible original syntax without reparsing or changing source extents", () => {
    const counter = {};
    expect(existingStaticShellSyntax(COMMAND, ["printf", "%s", "literal body text"], { totalTokens: 400 }, counter)).toBeUndefined();
    const original = shellSyntaxObservation(COMMAND, "bash", { totalTokens: 400 }, counter);
    const parse = vi.spyOn(shellAnalysis, "analyzeShell");
    try {
      const selected = existingStaticShellSyntax(COMMAND, ["printf", "%s", "literal body text"], { totalTokens: 400 }, counter);
      expect(selected).toEqual({ command: COMMAND, analysis: original.analysis });
      expect(selected?.analysis).toBe(original.analysis);
      expect(parse).not.toHaveBeenCalled();
      expect(existingStaticShellSyntax(COMMAND, ["printf", "%s", "literal body text"], { totalTokens: 399 }, counter)).toBeUndefined();
    } finally { parse.mockRestore(); }
  });

  it.each([
    { source: "VALUE=1 cat file", argv: ["cat", "file"] },
    { source: "cat < file", argv: ["cat"] },
    { source: "cat file | cat other", argv: ["cat", "file"] },
    { source: "cat file; cat other", argv: ["cat", "file"] },
    { source: "cat $FILE", argv: ["cat", "file"] },
    { source: "cat $(printf file)", argv: ["cat", "file"] },
    { source: "cat ~/notes", argv: ["cat", "~/notes"] },
    { source: "cat *.ts", argv: ["cat", "*.ts"] },
    { source: "cat 'file'", argv: ["cat", "different"] },
    { source: "cat 'file'", argv: ["cat", undefined] },
    { source: "cat 'file'", argv: ["cat"] },
  ])("keeps unsupported or different bound arguments on the existing adapter: $source", ({ source, argv }) => {
    const counter = {};
    shellSyntaxObservation(source, "bash", { totalTokens: 400 }, counter);
    expect(existingStaticShellSyntax(source, argv, { totalTokens: 400 }, counter)).toBeUndefined();
  });

  it("does not parse the serialized native spelling of an already inspected literal body", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "native-syntax-reuse-")));
    vi.stubEnv("AVE_HOME", join(root, "state"));
    const parse = vi.spyOn(shellAnalysis, "analyzeShell");
    try {
      const manager = new PermissionManager(join(root, "permissions.json")); manager.setMode("allow");
      const body = "./" + "AppData/Local/a/User Data/b/".repeat(64) + "tail";
      const command = "printf %s '" + body + "'";
      for (let observation = 0; observation < 2; observation++) {
        expect(manager.checkDetailed("bash", "builtin", "shell", null, { ruleSubject: { kind: "shell", dialect: "bash", command, cwd: root }, shellExecution: { runsSandboxed: true } }))
          .toMatchObject({ decision: "allow", reasonCode: "read-only-shell" });
      }
      expect(parse.mock.calls.map(([source]) => source)).toEqual([command, body, command, body]);
    } finally { parse.mockRestore(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });
});
