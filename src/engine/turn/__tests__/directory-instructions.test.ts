/**
 * Subdirectory instruction files ride the first successful builtin tool result
 * that touches their directory, once per session; the launch chain is revalidated
 * when any file on it appears or changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { directoryInstructionsForToolResult } from "../directory-instructions.js";

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "ave-dir-instructions-"));
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "AGENTS.md"), "src rule");
});

afterEach(async () => {
  await cleanupTmpDir(project);
});

function attach(attached: Set<string>, overrides: Partial<Parameters<typeof directoryInstructionsForToolResult>[0]> = {}) {
  return directoryInstructionsForToolResult({
    projectRoot: project,
    source: "builtin",
    toolInput: { path: join("src", "index.ts") },
    isError: false,
    attached,
    ...overrides,
  });
}

describe("directoryInstructionsForToolResult", () => {
  it("frames the file as project-provided and attaches it only once", () => {
    const attached = new Set<string>();
    const block = attach(attached);
    expect(block).toContain('trust="project-provided"');
    expect(block).toContain("src rule");
    expect(attach(attached)).toBeUndefined();
  });

  it("attaches nothing for failed calls, non-builtin tools, or inputs without a path", () => {
    expect(attach(new Set(), { isError: true })).toBeUndefined();
    expect(attach(new Set(), { source: "mcp" })).toBeUndefined();
    expect(attach(new Set(), { toolInput: { command: "ls src" } })).toBeUndefined();
    expect(attach(new Set(), { projectRoot: undefined })).toBeUndefined();
  });
});

describe("project instruction cache", () => {
  it("notices a file created on the chain after the first read", () => {
    const aveDir = mkdtempSync(join(tmpdir(), "ave-dir-instructions-home-"));
    try {
      const memory = new MemoryManager({ aveDir });
      expect(memory.getProjectAgentsMd(project).layers).toHaveLength(0);
      writeFileSync(join(project, "CLAUDE.md"), "fallback rule");
      expect(memory.getProjectAgentsMd(project).layers[0]?.content).toContain("fallback rule");
      writeFileSync(join(project, "CLAUDE.md"), "edited rule");
      const later = new Date(Date.now() + 5_000);
      utimesSync(join(project, "CLAUDE.md"), later, later);
      expect(memory.getProjectAgentsMd(project).layers[0]?.content).toContain("edited rule");
    } finally {
      void cleanupTmpDir(aveDir);
    }
  });
});
