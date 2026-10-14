/**
 * terminal_read: the agent's read path to terminal command blocks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTerminalReadTool } from "../terminal-read.js";
import {
  TerminalBlockTracker,
  registerTerminalBlockTracker,
  __resetTerminalBlocksForTest,
} from "../../main/terminal/terminal-blocks.js";
import type { ToolExecutionContext } from "../types.js";

const ctx = {} as ToolExecutionContext;
const osc = (body: string): string => `\u001b]${body}\u0007`;

function trackerWith(commands: Array<{ command: string; output: string; exit: number }>): TerminalBlockTracker {
  const tracker = new TerminalBlockTracker();
  for (const { command, output, exit } of commands) {
    tracker.recordOutput(`${osc(`133;C;cmdline_url=${encodeURIComponent(command)}`)}${output}${osc(`133;D;${exit}`)}`);
  }
  return tracker;
}

async function call(input: unknown) {
  const result = await createTerminalReadTool().execute(input, ctx);
  return { isError: result.isError, body: JSON.parse(result.output as string) as Record<string, unknown> };
}

afterEach(() => __resetTerminalBlocksForTest());

describe("terminal_read", () => {
  it("is a read-only builtin in the read category", () => {
    const tool = createTerminalReadTool();
    expect(tool).toMatchObject({ name: "terminal_read", source: "builtin", category: "read" });
    expect(tool.isReadOnly({})).toBe(true);
  });

  it("lists terminals with recent block summaries and no output", async () => {
    registerTerminalBlockTracker("terminal:1", trackerWith([
      { command: "npm test", output: "1 failed\r\n", exit: 1 },
      { command: "git status", output: "clean\r\n", exit: 0 },
    ]));
    const { isError, body } = await call({});
    expect(isError).toBe(false);
    const terminals = body.terminals as Array<{ tabId: string; shellIntegration: boolean; recentBlocks: Array<Record<string, unknown>> }>;
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ tabId: "terminal:1", shellIntegration: true, exited: false });
    expect(terminals[0]!.recentBlocks.map((block) => block.command)).toEqual(["git status", "npm test"]);
    expect(terminals[0]!.recentBlocks[0]).not.toHaveProperty("output");
  });

  it("says so when no terminal is open", async () => {
    const { isError, body } = await call({});
    expect(isError).toBe(false);
    expect(body.terminals).toEqual([]);
    expect(typeof body.note).toBe("string");
  });

  it("reads the newest blocks of a tab with output, and one block by id", async () => {
    registerTerminalBlockTracker("terminal:2", trackerWith([
      { command: "a", output: "A\r\n", exit: 0 },
      { command: "b", output: "B\r\n", exit: 3 },
      { command: "c", output: "C\r\n", exit: 0 },
    ]));
    const recent = await call({ tabId: "terminal:2", limit: 2 });
    expect((recent.body.blocks as Array<{ command: string; output: string }>).map((b) => [b.command, b.output]))
      .toEqual([["c", "C\n"], ["b", "B\n"]]);

    const one = await call({ tabId: "terminal:2", blockId: 2 });
    expect(one.body.block).toMatchObject({ id: 2, command: "b", exitCode: 3, output: "B\n" });
  });

  it("bounds the output of one response across blocks, keeping each block's tail", async () => {
    const big = `${"y".repeat(60_000)}\r\nEND\r\n`;
    registerTerminalBlockTracker("terminal:1", trackerWith([
      { command: "one", output: big, exit: 0 },
      { command: "two", output: big, exit: 0 },
    ]));
    const { body } = await call({ tabId: "terminal:1", limit: 2 });
    const blocks = body.blocks as Array<{ output: string; outputClippedForResponse?: boolean }>;
    const total = blocks.reduce((sum, block) => sum + block.output.length, 0);
    expect(total).toBeLessThanOrEqual(96 * 1024);
    expect(blocks[0]!.outputClippedForResponse).toBeUndefined();
    expect(blocks[1]!.outputClippedForResponse).toBe(true);
    expect(blocks[1]!.output.endsWith("END\n")).toBe(true);
  });

  it("rejects malformed input and unknown tabs or blocks", async () => {
    registerTerminalBlockTracker("terminal:1", trackerWith([{ command: "x", output: "", exit: 0 }]));
    for (const input of [
      { tabId: 7 },
      { tabId: "terminal:1", blockId: 0 },
      { tabId: "terminal:1", limit: 21 },
      { blockId: 1 },
      { tabId: "terminal:9" },
      { tabId: "terminal:1", blockId: 5 },
    ]) {
      expect((await call(input)).isError, JSON.stringify(input)).toBe(true);
    }
  });
});
