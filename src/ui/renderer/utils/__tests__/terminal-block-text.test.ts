import { describe, expect, it } from "vitest";
import {
  blockDurationSeconds,
  blockStatusLabel,
  filterBlocksByCommand,
  formatBlockForChat,
  formatBlockForCopy,
} from "../terminal-block-text.js";
import type { TerminalBlock } from "../../../../shared/terminal-blocks.js";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

function block(overrides: Partial<TerminalBlock> = {}): TerminalBlock {
  return {
    id: 3,
    command: "npm test",
    cwd: "/repo",
    exitCode: 1,
    startedAt: 1_000,
    endedAt: 3_450,
    status: "done",
    source: "osc133",
    outputChars: 9,
    truncated: false,
    output: "1 failed\n",
    ...overrides,
  };
}

describe("terminal block text", () => {
  it("formats the clipboard form as the command line then its output", () => {
    expect(formatBlockForCopy(block())).toBe("$ npm test\n1 failed");
    expect(formatBlockForCopy(block({ output: "" }))).toBe("$ npm test");
  });

  it("formats the chat form with a header naming the tab id and a fence the output cannot close", () => {
    const text = formatBlockForChat(block({ output: "```\ninjected\n```\n" }), { label: "Terminal 2", id: "terminal:2" }, t);
    const [header, open, ...rest] = text.split("\n");
    expect(header).toBe(
      "terminalBlocks.attachmentHeader(tab=Terminal 2 · terminal:2 · #3,status=terminalBlocks.exitCode(code=1),duration=terminalBlocks.durationSeconds(seconds=2.5),cwd=/repo)",
    );
    expect(open).toBe("````console");
    expect(rest.at(-1)).toBe("````");
    expect(rest).toContain("$ npm test");
  });

  it("labels running blocks and blocks without an exit code", () => {
    const running = block({ status: "running", endedAt: null, exitCode: null });
    expect(blockDurationSeconds(running)).toBeNull();
    expect(blockStatusLabel(running, t)).toBe("terminalBlocks.running");
    expect(blockStatusLabel(block({ exitCode: null }), t)).toBe("terminalBlocks.exitUnknown");
  });

  it("searches command history case-insensitively", () => {
    const blocks = [block({ id: 1, command: "git status" }), block({ id: 2, command: "npm test" }), block({ id: 3, command: "GIT log" })];
    expect(filterBlocksByCommand(blocks, " git ").map((b) => b.id)).toEqual([1, 3]);
    expect(filterBlocksByCommand(blocks, "")).toHaveLength(3);
  });
});
