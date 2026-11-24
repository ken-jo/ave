import { tsxChildEnv } from "../../../__tests__/support/tsx-child-env.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { capturePluginStderr } from "../plugin-stderr.js";

// Each child imports the real logger with packaged runtime facts before its module-load snapshot.
const PACKAGED_PROBE = `
Object.defineProperty(process.versions, "electron", { value: "45.1.0", configurable: true });
delete process.defaultApp;
delete process.env.LOG_LEVEL;
const { PassThrough } = await import("node:stream");
const { createLogger, logger } = await import("./src/lib/logger.ts");
const { capturePluginStderr } = await import("./src/plugins/isolation/plugin-stderr.ts");
createLogger("baseline").debug("discarded debug probe");
const stream = new PassThrough();
capturePluginStderr(stream, "packaged-probe");
stream.end("visible diagnostic\\nWARN raised warning\\nERROR raised error\\n");
process.stderr.write(JSON.stringify({ level: logger.level }));
`;

const LOCALE_PROBE = `
Object.defineProperty(process.versions, "electron", { value: "45.1.0", configurable: true });
delete process.defaultApp;
const { spawn } = await import("node:child_process");
const { once } = await import("node:events");
const { initFileLogSink, closeFileLogSink } = await import("./src/lib/logger.ts");
const { capturePluginStderr } = await import("./src/plugins/isolation/plugin-stderr.ts");
const { prepareSandboxTargetLaunch } = await import("./src/permissions/launcher-environment.ts");
const [dir, canary] = process.argv.slice(1);
const target = prepareSandboxTargetLaunch("/usr/bin/awk", [
  'BEGIN { print ENVIRON["LC_ALL"]; print "target diagnostic" > "/dev/stderr" }',
], { LC_ALL: canary });
const sink = initFileLogSink({ dir });
if (!sink) throw new Error("Fixture file sink unavailable");
const run = async (invalidFrame) => {
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", target.command], {
    env: {}, stdio: target.withStdio(["ignore", "pipe", "pipe"]),
  });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  capturePluginStderr(child.stderr, "locale-probe");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  if (invalidFrame) child.stdio[4].end("LC_ALL=" + canary + "\\0invalid-name=" + canary + "\\0\\0");
  else target.sendEnvironment(child);
  const [code] = await closed;
  return { code, stdout, stderr };
};
const complete = await run(false);
const failed = await run(true);
closeFileLogSink();
process.stderr.write(JSON.stringify({ complete, failed, file: sink.currentFile }));
`;

describe("plugin stderr capture", () => {
  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "persists target stderr without persisting diagnostics from environment setup",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "plugin-stderr-locale-"));
      const canary = "invalid-locale-fixture-canary";
      try {
        const result = spawnSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, [
          "--import", "tsx", "--input-type=module", "-e", LOCALE_PROBE, dir, canary,
        ], { encoding: "utf8", env: tsxChildEnv({ ELECTRON_RUN_AS_NODE: "1", LOG_LEVEL: "info" }) });
        expect(result.status, result.stderr).toBe(0);
        const { complete, failed, file } = JSON.parse(result.stderr);
        const persisted = readFileSync(file, "utf8");
        expect(complete).toEqual({ code: 0, stdout: `${canary}\n`, stderr: "target diagnostic\n" });
        expect(failed).toEqual({ code: 1, stdout: "", stderr: "" });
        expect(persisted).toContain("target diagnostic");
        expect(persisted).not.toContain(canary);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("masks each exact launch value from eight characters and preserves shorter values", () => {
    const stream = new PassThrough();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      capturePluginStderr(stream, "resolved-env", ["literal.*canary", "abcdefgh", "1234567"]);
      stream.end("literal.*canary literalXXcanary abcdefgh 1234567 literal.*canary\n");
      expect(info).toHaveBeenCalledExactlyOnceWith(
        "[plugin-stderr] [REDACTED] literalXXcanary [REDACTED] 1234567 [REDACTED]",
        { pluginId: "resolved-env" },
      );
    } finally { stream.destroy(); info.mockRestore(); }
  });

  it("masks launch values across stream chunks and embedded line breaks", () => {
    const stream = new PassThrough();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      capturePluginStderr(stream, "split-env", ["multi\r\nline-🔒", "split-canary"]);
      const diagnostic = Buffer.from("before multi\r\nline-🔒 split-canary after\n");
      const splitAt = diagnostic.indexOf(Buffer.from("🔒")) + 2;
      stream.write(diagnostic.subarray(0, splitAt));
      stream.write(diagnostic.subarray(splitAt, -8));
      expect(info).not.toHaveBeenCalled();
      stream.end(diagnostic.subarray(-8));
      expect(info).toHaveBeenCalledExactlyOnceWith("[plugin-stderr] before [REDACTED] [REDACTED] after", { pluginId: "split-env" });
    } finally { stream.destroy(); info.mockRestore(); }
  });

  it.each([
    ["overlapping values", ["abcdefgh12", "12345678xy"], "abcdefgh12345678xy"],
    ["a self-overlapping value", ["SECRETSE"], "SECRETSECRETSE"],
  ])("masks the union of %s, whole and byte by byte", (_name, values, text) => {
    for (const chunked of [false, true]) {
      const stream = new PassThrough();
      const info = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        capturePluginStderr(stream, "overlap-env", values);
        const diagnostic = Buffer.from(`before ${text} after\n`);
        if (chunked) for (const byte of diagnostic) stream.write(Buffer.from([byte]));
        else stream.write(diagnostic);
        stream.end();
        expect(info).toHaveBeenCalledExactlyOnceWith("[plugin-stderr] before [REDACTED] after", { pluginId: "overlap-env" });
      } finally { stream.destroy(); info.mockRestore(); }
    }
  });

  it("masks a clipped value prefix of eight characters or more when the stream ends", () => {
    const stream = new PassThrough();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      capturePluginStderr(stream, "clipped-env", ["SECRET-VALUE-123456"]);
      stream.write("before SECRET-VALUE-12");
      stream.emit("end");
      expect(info).toHaveBeenCalledExactlyOnceWith("[plugin-stderr] before [REDACTED]", { pluginId: "clipped-env" });
    } finally { stream.destroy(); info.mockRestore(); }
  });

  it("keeps a clipped prefix shorter than eight characters when the stream ends", () => {
    const stream = new PassThrough();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      capturePluginStderr(stream, "short-clip-env", ["SECRET-VALUE-123456"]);
      stream.write("before SECRET");
      stream.emit("end");
      expect(info).toHaveBeenCalledExactlyOnceWith("[plugin-stderr] before SECRET", { pluginId: "short-clip-env" });
    } finally { stream.destroy(); info.mockRestore(); }
  });

  it("redacts a credential crossing the output byte cap before truncation", () => {
    const stream = new PassThrough();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      capturePluginStderr(stream, "cap-secret");
      const token = "ghp_" + "A".repeat(36);
      stream.end("x".repeat(16_384 - 9) + " " + token + " tail\n");
      const line = String(info.mock.calls[0]?.[0]);
      expect(line).not.toContain("ghp_");
      expect(line).not.toContain("AAAA");
      expect(line).toContain("[truncated]");
    } finally { stream.destroy(); info.mockRestore(); }
  });

  it("discards overlong raw text rather than retaining an unredactable secret prefix", () => {
    const stream = new PassThrough();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      capturePluginStderr(stream, "raw-overflow");
      stream.end("ghp_" + "A".repeat(100_000) + "\nnext\n");
      expect(info.mock.calls[0]?.[0]).toContain("[truncated: line exceeded capture limit]");
      expect(info.mock.calls[0]?.[0]).not.toContain("ghp_");
      expect(info.mock.calls[1]?.[0]).toContain("next");
    } finally { stream.destroy(); info.mockRestore(); }
  });

  it("truncates valid UTF-8 on a character boundary", () => {
    const stream = new PassThrough();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      capturePluginStderr(stream, "cap-unicode");
      stream.end("x".repeat(16_383) + "€tail\n");
      const line = String(info.mock.calls[0]?.[0]);
      expect(line).not.toContain("\uFFFD");
      expect(line).toContain("x".repeat(16_383) + " [truncated]");
    } finally { stream.destroy(); info.mockRestore(); }
  });

  it("retains the same plugin budget after all of its children restart", () => {
    vi.useFakeTimers();
    const first = new PassThrough(), restarted = new PassThrough();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      capturePluginStderr(first, "restart-rate");
      first.write("line\n".repeat(500));
      first.emit("close");
      capturePluginStderr(restarted, "restart-rate");
      restarted.write("crash-loop-burst\n");
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining("crash-loop-burst"), expect.anything());
      restarted.emit("close");
      expect(info).toHaveBeenCalledWith(expect.stringContaining("rate limit"), { pluginId: "restart-rate", droppedLines: 1 });
    } finally { first.destroy(); restarted.destroy(); info.mockRestore(); vi.useRealTimers(); }
  });

  it("retains info diagnostics under the packaged logger default and raises explicit levels", () => {
    const result = spawnSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", PACKAGED_PROBE,
    ], { encoding: "utf8", env: tsxChildEnv({ ELECTRON_RUN_AS_NODE: "1" }) });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stderr)).toEqual({ level: "info" });
    const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map(({ level, pluginId, msg }) => ({ level, pluginId, msg }))).toEqual([
      { level: 30, pluginId: "packaged-probe", msg: "visible diagnostic" },
      { level: 40, pluginId: "packaged-probe", msg: "WARN raised warning" },
      { level: 50, pluginId: "packaged-probe", msg: "ERROR raised error" },
    ]);
  });

  it("shares the rate budget across children of one plugin and isolates other plugins", () => {
    vi.useFakeTimers();
    const first = new PassThrough(), second = new PassThrough(), other = new PassThrough();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      capturePluginStderr(first, "shared-rate"); capturePluginStderr(second, "shared-rate"); capturePluginStderr(other, "other-rate");
      first.write("line\n".repeat(500));
      second.write("excess\n");
      other.write("separate\n");
      expect(info.mock.calls.filter(([, fields]) => (fields as { pluginId: string }).pluginId === "shared-rate")).toHaveLength(500);
      expect(info).toHaveBeenCalledWith(expect.stringContaining("separate"), { pluginId: "other-rate" });
      first.emit("close"); second.emit("close"); other.emit("close");
      expect(info).toHaveBeenCalledWith(expect.stringContaining("rate limit"), { pluginId: "shared-rate", droppedLines: 1 });
    } finally {
      first.destroy(); second.destroy(); other.destroy(); info.mockRestore(); vi.useRealTimers();
    }
  });

  it("flushes the final unterminated line exactly once", () => {
    const stream = new PassThrough();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      capturePluginStderr(stream, "last-line");
      stream.write("last diagnostic");
      expect(info).not.toHaveBeenCalled();
      stream.emit("end"); stream.emit("close");
      expect(info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("last diagnostic"), { pluginId: "last-line" });
    } finally { stream.destroy(); info.mockRestore(); }
  });
});
