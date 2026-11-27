import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import type { PermissionDecisionRequest } from "../decision-pipeline.js";
import { decideUnattended } from "../unattended-lane.js";

vi.mock(import("node:path"), async importOriginal => {
  const paths = await importOriginal();
  return { ...paths, isAbsolute: paths.posix.isAbsolute, relative: paths.posix.relative, sep: paths.posix.sep };
});

it.each([
  ["/Users/alice/ws/report.txt", "/users/alice/ws/report.txt", "allow"],
  ["/Users/alice/references/report.txt", "/users/alice/references/report.txt", "allow"],
  ["/users/alice/ws/report.txt", "/users/alice/ws/report.txt", "deny"],
  ["/Users/alice/ws/report.txt", "/users/alice/outside/report.txt", "deny"],
] as const)("checks both spellings of a darwin read: %s → %s", (lexical, canonical, outcome) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform, "Expected a process.platform descriptor");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    const request: PermissionDecisionRequest = {
      mode: "default", headless: true, tool: { name: "read_file", kind: "read", source: "builtin" },
      paths: [{ lexical, canonical, effect: "read" }],
      unattendedEffect: "safe",
      unattended: {
        runKey: "run", stageId: "stage", workspaceRoot: "/Users/alice/ws", isolation: { proven: true },
        envelope: {
          tools: ["read_file"], readRoots: ["/Users/alice/references"], writePaths: [],
          commands: [], network: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
          outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
        },
      },
    };
    expect(decideUnattended(request).outcome).toBe(outcome);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
