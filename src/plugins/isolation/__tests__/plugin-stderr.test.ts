import { spawnSync } from "node:child_process";
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

describe("plugin stderr capture", () => {
  it("retains info diagnostics under the packaged logger default and raises explicit levels", () => {
    const result = spawnSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", PACKAGED_PROBE,
    ], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TSX_DISABLE_CACHE: "1" } });
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
