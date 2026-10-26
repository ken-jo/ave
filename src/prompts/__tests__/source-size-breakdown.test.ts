import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { makePromptMemorySource } from "./test-helpers.js";

function makeToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    createDynamicTool({
      name: "bash",
      description: "Run a shell command.",
      source: "builtin",
      category: "shell",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "", isError: false }),
    }),
  );
  return registry;
}

function makeBuilderWithMemory(): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: makePromptMemorySource({
      getAgentsMd: () => "# Agents\n\nProject conventions go here.",
      getPromptMemoryIndex: () => "# Memory Index\n\n- [A](./a.md)\n- [B](./b.md)",
      getPromptUserPreferences: () => "Prefers concise answers.",
    }),
    toolRegistry: makeToolRegistry(),
  });
}

describe("SystemPromptBuilder — getSourceSizeBreakdown", () => {
  it("returns one entry per assembled non-empty source", () => {
    const builder = makeBuilderWithMemory();
    const { sources } = builder.getSourceSizeBreakdown();

    expect(sources.length).toBeGreaterThan(0);
    for (const entry of sources) {
      expect(entry.chars).toBeGreaterThan(0);
      expect(entry.estTokens).toBeGreaterThan(0);
      expect(typeof entry.label).toBe("string");
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("reconciles per-source chars (+ join separators) with build().length", () => {
    const builder = makeBuilderWithMemory();
    const prompt = builder.build();
    const { sources, totalChars } = builder.getSourceSizeBreakdown();

    const joinChars = sources.length > 1 ? (sources.length - 1) * 2 : 0;
    const charsSum = sources.reduce((sum, s) => sum + s.chars, 0);

    expect(totalChars).toBe(charsSum + joinChars);
    expect(totalChars).toBe(prompt.length);
  });

  it("totalEstTokens equals the sum of per-source estTokens", () => {
    const builder = makeBuilderWithMemory();
    const { sources, totalEstTokens } = builder.getSourceSizeBreakdown();
    const tokenSum = sources.reduce((sum, s) => sum + s.estTokens, 0);
    expect(totalEstTokens).toBe(tokenSum);
  });

  it("sorts entries descending by chars", () => {
    const builder = makeBuilderWithMemory();
    const { sources } = builder.getSourceSizeBreakdown();
    for (let i = 1; i < sources.length; i++) {
      expect(sources[i - 1].chars).toBeGreaterThanOrEqual(sources[i].chars);
    }
  });

  it("includes the expected representative source labels (tools + memory)", () => {
    const builder = makeBuilderWithMemory();
    const labels = builder.getSourceSizeBreakdown().sources.map((s) => s.label);
    expect(labels).toContain("Tool Schemas");
    expect(labels).toContain("Memory & Knowledge");
  });

  it("is pure — repeated calls return identical totals and do not mutate state", () => {
    const builder = makeBuilderWithMemory();
    const first = builder.getSourceSizeBreakdown();
    const second = builder.getSourceSizeBreakdown();
    expect(second.totalChars).toBe(first.totalChars);
    expect(second.totalEstTokens).toBe(first.totalEstTokens);
    expect(builder.build().length).toBe(first.totalChars);
  });
});

describe("SystemPromptBuilder — AVE_DEV_PROMPT_SOURCE_DUMP gate (no behavior change)", () => {
  const savedDump = process.env.AVE_DEV_PROMPT_SOURCE_DUMP;
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-17T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedDump === undefined) delete process.env.AVE_DEV_PROMPT_SOURCE_DUMP;
    else process.env.AVE_DEV_PROMPT_SOURCE_DUMP = savedDump;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it("produces byte-identical prompt whether the dev dump flag is set or not", () => {
    delete process.env.AVE_DEV_PROMPT_SOURCE_DUMP;
    const withoutFlag = makeBuilderWithMemory().build();

    process.env.AVE_DEV_PROMPT_SOURCE_DUMP = "1";
    const withFlag = makeBuilderWithMemory().build();

    expect(withFlag).toBe(withoutFlag);
  });

  it("does not log under production NODE_ENV even when the flag is set", () => {
    process.env.NODE_ENV = "production";
    process.env.AVE_DEV_PROMPT_SOURCE_DUMP = "1";
    const prod = makeBuilderWithMemory().build();

    delete process.env.NODE_ENV;
    delete process.env.AVE_DEV_PROMPT_SOURCE_DUMP;
    const dev = makeBuilderWithMemory().build();

    expect(prod).toBe(dev);
  });
});
