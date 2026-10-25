import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe.skipIf(process.platform !== "win32")("Fixture account identity cache", () => {
  it.each(["process error", "missing identity", "synchronous error"])("retries after %s and caches success", async (failure) => {
    vi.resetModules();
    const { fakeFixtureAclTransport } = await import("./native-executable.js");
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
    const transport = fakeFixtureAclTransport(lookup as unknown as typeof childProcess.execFile);
    let id = 0;
    const probe = async () => (JSON.parse(await transport.request(
      { id: ++id, paths: [root], capSids: [], skipPackage: false, setOwner: false },
      { command: "fixture-probe", args: [], options: { windowsHide: true, env: {} } },
      { timeoutMs: 1_000, maxBytes: 1024 },
    )) as { id: number; result: { currentSid: string } });
    try {
      await expect(probe()).rejects.toThrow(failure === "missing identity" ? "SID is unavailable" : "Identity lookup failed");
      expect(lookup).toHaveBeenCalledTimes(1);
      expect((await probe()).result.currentSid).toBe(sid);
      expect((await probe()).result.currentSid).toBe(sid);
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
