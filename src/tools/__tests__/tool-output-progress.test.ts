import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";
import {
  createLiveOutputStream,
  createMaskedProgressRelay,
  MASKED_RELAY_HELD_LIMIT_CHARS,
  MASKED_RELAY_IDLE_MS,
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
    const stream = createLiveOutputStream({ write: sink, end: () => {} });
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
    const stream = createLiveOutputStream({ write: sink, end: () => {} });
    stream.write("stdout", Buffer.from("x".repeat(LIVE_OUTPUT_FLUSH_CHARS)));
    expect(sink).toHaveBeenCalledExactlyOnceWith("x".repeat(LIVE_OUTPUT_FLUSH_CHARS));
  });

  it("reassembles a code point split across reads of one pipe", () => {
    const sink = vi.fn();
    const stream = createLiveOutputStream({ write: sink, end: () => {} });
    const bytes = Buffer.from("한", "utf8");
    stream.write("stdout", bytes.subarray(0, 1));
    stream.write("stderr", Buffer.from("!"));
    stream.write("stdout", bytes.subarray(1));
    stream.close();
    expect(sink.mock.calls.map(([text]) => text).join("")).toBe("!한");
  });

  it("stops after the per-call limit with one notice", () => {
    const sink = vi.fn();
    const stream = createLiveOutputStream({ write: sink, end: () => {} });
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
    const stream = createLiveOutputStream({ write: sink, end: () => {} });
    stream.close();
    stream.write("stdout", Buffer.from("late"));
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("masked live output relay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A credential the masker always removes, PII redaction on or off.
  const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const relay = (pii = true) => {
    const delivered: string[] = [];
    const sink = createMaskedProgressRelay(
      (text) => { delivered.push(text); },
      (text) => maskSensitiveData(text, { pii }).masked,
    );
    return { sink, delivered, all: () => delivered.join("") };
  };

  it("masks a secret split across two chunks before any of it is delivered", () => {
    const { sink, delivered, all } = relay();
    sink.write(`step 1\nexport GH_TOKEN=${TOKEN.slice(0, 10)}`);
    expect(delivered).toEqual(["step 1\n"]);
    sink.write(`${TOKEN.slice(10)}\nstep 2\n`);
    sink.end();
    expect(all()).not.toContain(TOKEN.slice(0, 10));
    expect(all()).not.toContain(TOKEN.slice(10));
    expect(all()).toContain("step 2");
  });

  it("masks a secret at the very end of the stream", () => {
    const { sink, all } = relay();
    sink.write("token follows ");
    sink.write(TOKEN);
    sink.end();
    expect(all()).not.toContain(TOKEN);
    expect(all()).toContain("token follows");
  });

  it("still masks credentials with PII redaction off", () => {
    const { sink, all } = relay(false);
    sink.write(`a@example.com ${TOKEN.slice(0, 20)}`);
    sink.write(`${TOKEN.slice(20)}\n`);
    sink.end();
    expect(all()).not.toContain(TOKEN.slice(4, 20));
    expect(all()).toContain("a@example.com");
  });

  it("holds a private key block until it is complete", () => {
    const { sink, delivered, all } = relay();
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    sink.write(`ok\n-----BEGIN PRIVATE KEY-----\n${body}\n`);
    expect(delivered.join("")).toBe("ok\n");
    sink.write("-----END PRIVATE KEY-----\ndone\n");
    sink.end();
    expect(all()).not.toContain(body);
    expect(all()).toContain("done");
  });

  it("streams a carriage-return progress bar as it updates", () => {
    const { sink, delivered } = relay();
    sink.write("\rfetch 10%");
    sink.write("\rfetch 55%");
    // Each update's leading \r ends the previous state, which is then shown.
    expect(delivered.join("")).toBe("\rfetch 10%\r");
    sink.write("\rfetch 90%\r");
    expect(delivered.join("")).toBe("\rfetch 10%\rfetch 55%\rfetch 90%\r");
  });

  it("releases a quiet unterminated prompt after the idle delay", () => {
    vi.useFakeTimers();
    const { sink, delivered } = relay();
    sink.write("Continue? [y/N] ");
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(MASKED_RELAY_IDLE_MS);
    expect(delivered).toEqual(["Continue? [y/N] "]);
  });

  it("masks a token inside the released part of a long unterminated line", () => {
    const { sink, all } = relay();
    sink.write(`x ${TOKEN} `);
    sink.write("y".repeat(MASKED_RELAY_HELD_LIMIT_CHARS));
    // Released before the line ends, and masked.
    expect(all().length).toBeGreaterThan(0);
    expect(all()).not.toContain(TOKEN);
    expect(all().startsWith("x ")).toBe(true);
  });

  it("never releases an open private key on the idle or size bounds", () => {
    vi.useFakeTimers();
    const { sink, all } = relay();
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7".repeat(100);
    sink.write(`-----BEGIN PRIVATE KEY-----\n${body}`);
    vi.advanceTimersByTime(MASKED_RELAY_IDLE_MS);
    expect(all()).not.toContain("MIIE");
  });

  it("delivers nothing after end", () => {
    const { sink, delivered } = relay();
    sink.end();
    sink.write("late\n");
    expect(delivered).toEqual([]);
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
        metadata: { [TOOL_OUTPUT_PROGRESS_METADATA_KEY]: { write: (text: string) => { chunks.push(text); }, end: () => {} } },
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

    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    outputs.length = 0;
    const [secret] = await executor.executeAll(
      [{ id: "live-2", name: "bash", input: { command: `printf 'GH_TOKEN=%s\\n' ${token}` } }],
      {
        sessionId: "live-session",
        executionCwd: dir,
        permissionContext: { trustOrigin: "user-keyboard" },
        callbacks: {
          onToolOutput: (name, text, meta) => { outputs.push({ name, text, toolUseId: meta.toolUseId }); },
        },
      },
    );
    // The model's result keeps the raw text; the live card never sees it.
    expect(String(secret!.content)).toContain(token);
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.map((output) => output.text).join("")).not.toContain(token);
  });
});
