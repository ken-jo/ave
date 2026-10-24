import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe.skipIf(process.platform !== "win32")("Fixture account identity cache", () => {
  it.each(["process error", "missing identity", "synchronous error"])("retries after %s and caches success", async (failure) => {
    vi.resetModules();
    const { fakeFixtureAcl } = await import("./native-executable.js");
    const root = mkdtempSync(join(tmpdir(), "ave-fixture-sid-"));
    const sid = "S-1-5-21-123-456-789-1001";
    const lookup = vi.fn((_file: string, _args: string[], _options: unknown, callback: Function) => {
      if (lookup.mock.calls.length === 1) {
        if (failure === "synchronous error") throw new Error("Identity lookup failed");
        queueMicrotask(() => callback(failure === "process error" ? new Error("Identity lookup failed") : null, "", ""));
      } else {
        queueMicrotask(() => callback(null, `"fixture","${sid}"`, ""));
      }
      return new childProcess.ChildProcess();
    });
    const module = fakeFixtureAcl({ ...childProcess, execFile: lookup as unknown as typeof childProcess.execFile });
    const probe = () => new Promise<string>((resolve, reject) => {
      module.execFile("fixture-probe", [], {
        env: { AVE_EXECUTABLE_ACL_PATHS: JSON.stringify([root]) },
        encoding: "utf8",
      }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    try {
      await expect(probe()).rejects.toThrow(failure === "missing identity" ? "SID is unavailable" : "Identity lookup failed");
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await probe()).currentSid).toBe(sid);
      expect(JSON.parse(await probe()).currentSid).toBe(sid);
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
