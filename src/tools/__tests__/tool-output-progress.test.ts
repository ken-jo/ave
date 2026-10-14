import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";
import {
  createLiveOutputStream,
  LIVE_OUTPUT_FLUSH_CHARS,
  LIVE_OUTPUT_FLUSH_MS,
  LIVE_OUTPUT_LIMIT_CHARS,
  LIVE_OUTPUT_LIMIT_NOTICE,
  TOOL_OUTPUT_PROGRESS_METADATA_KEY,
} from "../tool-output-progress.js";

describe("live output stream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces bursts into one delivery after the flush delay", () => {
    vi.useFakeTimers();
    const sink = vi.fn();
    const stream = createLiveOutputStream(sink);
    stream.write("stdout", Buffer.from("a"));
    stream.write("stderr", Buffer.from("b"));
    stream.write("stdout", Buffer.from("c"));
    expect(sink).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LIVE_OUTPUT_FLUSH_MS);
    expect(sink).toHaveBeenCalledExactlyOnceWith("abc");
  });

  it("delivers at once when the buffered text reaches the flush size", () => {
    vi.useFakeTimers();
    const sink = vi.fn();
    const stream = createLiveOutputStream(sink);
    stream.write("stdout", Buffer.from("x".repeat(LIVE_OUTPUT_FLUSH_CHARS)));
    expect(sink).toHaveBeenCalledExactlyOnceWith("x".repeat(LIVE_OUTPUT_FLUSH_CHARS));
  });

  it("reassembles a code point split across reads of one pipe", () => {
    const sink = vi.fn();
    const stream = createLiveOutputStream(sink);
    const bytes = Buffer.from("한", "utf8");
    stream.write("stdout", bytes.subarray(0, 1));
    stream.write("stderr", Buffer.from("!"));
    stream.write("stdout", bytes.subarray(1));
    stream.close();
    expect(sink.mock.calls.map(([text]) => text).join("")).toBe("!한");
  });

  it("stops after the per-call limit with one notice", () => {
    const sink = vi.fn();
    const stream = createLiveOutputStream(sink);
    const block = Buffer.from("y".repeat(LIVE_OUTPUT_FLUSH_CHARS));
    for (let written = 0; written <= LIVE_OUTPUT_LIMIT_CHARS; written += block.length) {
      stream.write("stdout", block);
    }
    stream.write("stdout", block);
    stream.close();
    const delivered = sink.mock.calls.map(([text]) => text as string).join("");
    expect(delivered.length).toBe(LIVE_OUTPUT_LIMIT_CHARS + LIVE_OUTPUT_LIMIT_NOTICE.length);
    expect(delivered.endsWith(LIVE_OUTPUT_LIMIT_NOTICE)).toBe(true);
  });

  it("delivers nothing after close", () => {
    const sink = vi.fn();
    const stream = createLiveOutputStream(sink);
    stream.close();
    stream.write("stdout", Buffer.from("late"));
    expect(sink).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("bash live output", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("streams both pipes while the final result keeps its bounded form", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ave-live-output-")));
    const chunks: string[] = [];
    const result = await new BashTool().execute(
      { command: "printf one; printf two >&2; cd .; printf three", timeoutSeconds: 10 },
      {
        cwd: dir,
        extraAllowedDirectories: [],
        metadata: { [TOOL_OUTPUT_PROGRESS_METADATA_KEY]: (text: string) => { chunks.push(text); } },
      },
    );
    // The two pipes interleave in arrival order, in the result as in the stream.
    const sorted = (text: string) => [...text].sort().join("");
    expect(sorted(result.output)).toBe(sorted("onetwothree"));
    const streamed = chunks.join("");
    expect(sorted(streamed)).toBe(sorted(result.output));
    // The cwd probe's report is never shown.
    expect(streamed).not.toContain("ave-cwd-");
  });

  it("reaches executor subscribers as onToolOutput with the call's identity", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ave-live-output-exec-")));
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const permissions = new PermissionManager(join(dir, "permissions.json"));
    permissions.setMode("allow");
    const executor = new ToolExecutor(
      registry, undefined, permissions, new BashAstValidator({ mode: "deny" }),
      undefined, undefined, undefined, () => true,
    );
    const outputs: Array<{ name: string; text: string; toolUseId: string }> = [];
    const [result] = await executor.executeAll(
      [{ id: "live-1", name: "bash", input: { command: "printf progress" } }],
      {
        sessionId: "live-session",
        executionCwd: dir,
        permissionContext: { trustOrigin: "user-keyboard" },
        callbacks: {
          onToolOutput: (name, text, meta) => { outputs.push({ name, text, toolUseId: meta.toolUseId }); },
        },
      },
    );
    expect(String(result!.content)).toBe("progress");
    expect(outputs).toEqual([{ name: "bash", text: "progress", toolUseId: "live-1" }]);
  });
});
