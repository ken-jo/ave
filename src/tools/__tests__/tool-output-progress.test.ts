import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
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

  it("keeps a token that pauses mid-way hidden until it completes", () => {
    vi.useFakeTimers();
    const { sink, delivered, all } = relay();
    sink.write(`export GH_TOKEN ${TOKEN.slice(0, 12)}`);
    vi.advanceTimersByTime(MASKED_RELAY_IDLE_MS * 4);
    // The text before the token shows; no byte of the token does.
    expect(all()).toBe("export GH_TOKEN ");
    sink.write(`${TOKEN.slice(12)} done`);
    vi.advanceTimersByTime(MASKED_RELAY_IDLE_MS);
    expect(all()).not.toContain(TOKEN.slice(4, 12));
    expect(all()).not.toContain(TOKEN.slice(12));
    expect(all()).toContain(" done");
    expect(delivered.length).toBeGreaterThan(1);
  });

  it("masks a paused token when the stream ends before it completes", () => {
    vi.useFakeTimers();
    const { sink, all } = relay();
    sink.write(`token ${TOKEN.slice(0, 20)}`);
    vi.advanceTimersByTime(MASKED_RELAY_IDLE_MS);
    sink.write(TOKEN.slice(20));
    sink.end();
    expect(all()).not.toContain(TOKEN.slice(4));
    expect(all()).toContain("token ");
  });

  it("still shows a plain password prompt after the idle delay", () => {
    vi.useFakeTimers();
    const { sink, delivered } = relay();
    sink.write("Password: ");
    vi.advanceTimersByTime(MASKED_RELAY_IDLE_MS);
    expect(delivered).toEqual(["Password: "]);
  });

  const mask = (text: string) => maskSensitiveData(text, { pii: true }).masked;

  it("holds an Authorization header through a pause before its value", () => {
    vi.useFakeTimers();
    const { sink, delivered, all } = relay();
    const value = "abcdef123456XYZ";
    sink.write("step\nAuthorization: Bearer ");
    // Longer than the old 500 ms idle release, shorter than the bound.
    vi.advanceTimersByTime(1_000);
    // The partial line waits whole; only the finished line is shown.
    expect(delivered).toEqual(["step\n"]);
    sink.write(`${value}\n`);
    sink.end();
    expect(all()).not.toContain(value);
    expect(all()).toBe(mask(`step\nAuthorization: Bearer ${value}\n`));
  });

  it("masks a value that arrives after its Authorization prefix was released", () => {
    vi.useFakeTimers();
    const { sink, delivered, all } = relay();
    const value = "abcdef123456XYZ";
    sink.write("Authorization: Bearer ");
    vi.advanceTimersByTime(MASKED_RELAY_IDLE_MS);
    expect(delivered.length).toBe(1);
    sink.write(`${value}\nnext\n`);
    sink.end();
    expect(all()).not.toContain(value);
    expect(all()).toBe(mask(`Authorization: Bearer ${value}\nnext\n`));
  });

  it.each([
    ["a URL token=", "curl https://api.example.com/v1?token=", "Zq7xK2mVw9Lp4Rt8Yb3N\n"],
    ["a JSON api_key:", '{"api_key": "', 'Zq7xK2mVw9Lp4Rt8Yb3N"}\n'],
    ["an x-api-key: header", "x-api-key: ", "Zq7xK2mVw9Lp4Rt8Yb3N\n"],
    ["a password= line", "password=", "Zq7xK2mVw9Lp4Rt8Yb3N\n"],
    ["a token= assignment", "token=", "Zq7xK2mVw9Lp4Rt8Yb3N\n"],
    ["an api_key: field", "api_key: ", "Zq7xK2mVw9Lp4Rt8Yb3N\n"],
  ])("shows %s value live exactly as the final result masks it", (_name, prefix, rest) => {
    for (const pause of [1_000, MASKED_RELAY_IDLE_MS * 2]) {
      vi.useFakeTimers();
      const { sink, all } = relay();
      sink.write(prefix);
      vi.advanceTimersByTime(pause);
      sink.write(rest);
      sink.end();
      expect(all()).toBe(mask(prefix + rest));
      vi.useRealTimers();
    }
  });

  it("shows a prompt without a trailing newline within the bound", () => {
    vi.useFakeTimers();
    const { sink, delivered } = relay();
    sink.write("done\nProceed with install (yes/no)? ");
    vi.advanceTimersByTime(MASKED_RELAY_IDLE_MS - 1);
    expect(delivered).toEqual(["done\n"]);
    vi.advanceTimersByTime(1);
    expect(delivered.join("")).toBe("done\nProceed with install (yes/no)? ");
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

  it("redacts an unfinished private key when a command closes", () => {
    const { sink, all } = relay();
    sink.write("step\n-----BEGIN PRIVATE KEY-----\nunfinished-private-material");
    sink.end();
    expect(all()).toBe("step\n[REDACTED:PRIVATE_KEY]");
  });

  it("bounds an open private key and resumes only after its split footer", () => {
    const delivered: string[] = [];
    const sink = createMaskedProgressRelay((text) => delivered.push(text),
      (text) => maskSensitiveData(text, { pii: false }).masked, { maxHeldChars: 8192 });
    sink.write("start\n-----BEGIN PRIVATE KEY-----\n");
    for (let index = 0; index < 100; index++) sink.write("private-material".repeat(1024));
    sink.write("-----END PRIVATE ");
    sink.write("KEY-----\nresumed\n");
    sink.end();
    expect(delivered.join("")).toBe("start\n[REDACTED:PRIVATE_KEY]\nresumed\n");
  });

  it("discards an oversized credential line without leaking a suffix and continues its tail", () => {
    const delivered: string[] = [];
    const sink = createMaskedProgressRelay((text) => delivered.push(text),
      (text) => maskSensitiveData(text, { pii: false }).masked, { maxHeldChars: 8192 });
    sink.write("Authorization: Bearer ");
    for (let index = 0; index < 100; index++) sink.write("credential-body".repeat(1024));
    sink.write("\nresumed\n");
    sink.end();
    expect(delivered.join("")).not.toContain("credential-body");
    expect(delivered.join("")).toContain("resumed\n");
    expect(delivered.join("").length).toBeLessThan(100);
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
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const permissions = new PermissionManager(join(dir, "permissions.json"));
    permissions.setRules([
      { pattern: "Bash(printf progress)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION },
      { pattern: `Bash(printf GH_TOKEN=%s ${token})`, action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION },
    ]);
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

    outputs.length = 0;
    const [secret] = await executor.executeAll(
      [{ id: "live-2", name: "bash", input: { command: `printf GH_TOKEN=%s ${token}` } }],
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
