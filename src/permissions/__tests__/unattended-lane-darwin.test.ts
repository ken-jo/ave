import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { PermissionDecisionRequest } from "../decision-pipeline.js";
import { resolvePathForPolicy } from "../sensitive-paths.js";
import { decideUnattended } from "../unattended-lane.js";

it.skipIf(process.platform === "win32")("judges native spelling independently of the folded macOS policy key", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-unattended-case-")));
  try {
    const workspaceRoot = join(root, "Workspace");
    const references = join(root, "References");
    const declared = join(root, "Declared");
    mkdirSync(workspaceRoot);
    mkdirSync(references);
    symlinkSync(references, declared, "dir");
    const input = join(workspaceRoot, "report.txt");
    const reference = join(declared, "report.txt");
    const request: PermissionDecisionRequest = {
      mode: "default", headless: true, tool: { name: "read_file", kind: "read", source: "builtin" },
      unattendedEffect: "safe",
      unattended: {
        runKey: "run", stageId: "stage", workspaceRoot, isolation: { proven: false }, readOnly: true,
        envelope: {
          tools: ["read_file"], readRoots: [declared], writePaths: [],
          commands: [], network: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
          outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
        },
      },
    };
    const check = (lexical: string, runtimePath: string | undefined, canonical = runtimePath?.toLowerCase() ?? lexical.toLowerCase()) =>
      decideUnattended({ ...request, paths: [{ lexical, canonical, runtimePath, effect: "read" }] }).outcome;
    expect(check(input, input)).toBe("allow");
    expect(check(reference, resolvePathForPolicy(reference))).toBe("allow");
    expect(check(input.toLowerCase(), input)).toBe("deny");
    expect(check(input, join(root, "outside", "report.txt"))).toBe("deny");
    expect(check(input, undefined)).toBe("deny");
    // Supply the result realpath would return if both siblings existed on a case-sensitive volume.
    const caseVariant = join(root, "workspace", "report.txt");
    expect(check(input, caseVariant)).toBe("deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("matches scheduled write globs against native names", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-unattended-write-")));
  try {
    const request: PermissionDecisionRequest = {
      mode: "default", headless: true, tool: { name: "write_file", kind: "file-write", source: "builtin" },
      unattendedEffect: "safe", fileWrite: { insideProject: true, checkpointAvailable: true },
      unattended: {
        runKey: "run", stageId: "stage", workspaceRoot: root, isolation: { proven: true },
        envelope: {
          tools: ["write_file"], readRoots: [], writePaths: ["Output/*.txt", "literal\\backslash.txt"],
          commands: [], network: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
          outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
        },
      },
    };
    const check = (lexicalName: string, actualName = lexicalName) => {
      const lexical = join(root, lexicalName);
      const runtimePath = join(root, actualName);
      return decideUnattended({ ...request, paths: [{ lexical, canonical: runtimePath.toLowerCase(), runtimePath, effect: "write" }] }).outcome;
    };
    expect.soft(check("Output/result.txt")).toBe("allow");
    expect.soft(check("Output/result.txt", "output/result.txt")).toBe("deny");
    expect.soft(check("Output\\result.txt")).toBe("deny");
    expect.soft(check("literal\\backslash.txt")).toBe("allow");
    expect.soft(check("literal/backslash.txt")).toBe("deny");
    expect.soft(check("literal\\backslash.txt\n")).toBe("deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
