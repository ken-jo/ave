import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand, wrapWorkerCommand } from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";
import * as integrity from "../srt-win-integrity.js";
import * as policyHome from "../../shared/policy-home.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

useVerifiedAveHomePrivacy();

describe.skipIf(process.platform !== "win32")("Windows placeholder adapter boundaries", () => {
  let fixture: string | undefined;

  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    vi.restoreAllMocks();
    if (fixture) await cleanupTmpDir(fixture);
    fixture = undefined;
  });

  function prepareFixture(): string {
    fixture = mkdtempSync(join(tmpdir(), "placeholder-boundary-"));
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([fixture]);
    vi.spyOn(integrity, "prepareSrtWinExecutable").mockImplementation(path => path);
    return join(fixture, "missing", "deep", "secret");
  }

  it("keeps placeholders until reset releases the deny and then removes their chain", async () => {
    const target = prepareFixture();
    vi.spyOn(SandboxManager, "initialize").mockImplementation(async () => {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
    });
    vi.spyOn(SandboxManager, "reset").mockImplementation(async () => {
      expect(existsSync(target)).toBe(true);
    });
    await initializeAsrtSandbox({ allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!], denyRead: [target] });
    expect(existsSync(target)).toBe(true);
    await resetAsrtSandbox();
    expect(existsSync(join(fixture!, "missing"))).toBe(false);
  });

  it("captures partially created paths when initialization throws and cleans after rollback", async () => {
    const target = prepareFixture();
    const failure = new Error("Fixture stamp failure");
    vi.spyOn(SandboxManager, "initialize").mockImplementation(async () => {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
      throw failure;
    });
    const reset = vi.spyOn(SandboxManager, "reset").mockImplementation(async () => {
      expect(existsSync(target)).toBe(true);
    });
    await expect(initializeAsrtSandbox({
      allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!], denyWrite: [target],
    })).rejects.toBe(failure);
    expect(reset).toHaveBeenCalledOnce();
    expect(existsSync(join(fixture!, "missing"))).toBe(false);
  });

  it("retains written data and logs the retained file once across repeated reset", async () => {
    const target = prepareFixture();
    vi.spyOn(SandboxManager, "initialize").mockImplementation(async () => {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
    });
    vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn");
    await initializeAsrtSandbox({ allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!], denyWrite: [target] });
    writeFileSync(target, "user data");
    await resetAsrtSandbox();
    await resetAsrtSandbox();
    expect(readFileSync(target, "utf8")).toBe("user data");
    expect(warn.mock.calls.filter(call => call.some(value => String(value).includes(target)))).toHaveLength(1);
  });

  it("runs exit cleanup after the runtime releases session denies", async () => {
    const target = prepareFixture();
    const prepend = vi.spyOn(process, "prependOnceListener");
    const release = vi.fn(() => { expect(existsSync(target)).toBe(true); });
    const dispose = vi.fn(() => { expect(existsSync(target)).toBe(false); });
    vi.spyOn(SandboxManager, "initialize").mockImplementation(async () => {
      process.once("exit", dispose);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
    });
    vi.spyOn(SandboxManager, "reset").mockImplementation(async () => { release(); });
    try {
      await initializeAsrtSandbox({ allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!], denyRead: [target] });
      const listeners = prepend.mock.calls.filter(([event]) => event === "exit").map(([, listener]) => listener);
      expect(listeners).toHaveLength(1);
      expect(process.listeners("exit").indexOf(listeners[0]!)).toBeLessThan(process.listeners("exit").indexOf(dispose));
      listeners[0]!(0);
      dispose();
      expect(release).toHaveBeenCalledOnce();
      expect(existsSync(join(fixture!, "missing"))).toBe(false);
    } finally {
      process.removeListener("exit", dispose);
      vi.mocked(SandboxManager.reset).mockResolvedValue(undefined);
    }
  });

  function prepareCommand(target: string): ReturnType<typeof openEgressInvocation> {
    vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
    vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined);
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockResolvedValue({
      argv: ["srt-win.exe", "--srt-win", "exec", "--deny-write", target, "--", "cmd.exe"], env: {},
    });
    return openEgressInvocation({
      kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: fixture!, approvalSurface: "unavailable" },
    });
  }

  it("tracks deny placeholders created by the tool executor after wrapping", async () => {
    const target = prepareFixture();
    const invocation = prepareCommand(target);
    try {
      await initializeAsrtSandbox({ allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!] });
      await wrapToolCommand("echo fixture", { commandId: invocation.token });
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
      invocation.release();
      expect(existsSync(target)).toBe(true);
      await resetAsrtSandbox();
      expect(existsSync(join(fixture!, "missing"))).toBe(false);
    } finally {
      invocation.release();
    }
  });

  it("defers worker placeholder cleanup until its process releases the invocation", async () => {
    const target = prepareFixture();
    const invocation = prepareCommand(target);
    try {
      await initializeAsrtSandbox({ allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!] });
      await wrapWorkerCommand("echo fixture", { commandId: invocation.token });
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
      await resetAsrtSandbox();
      expect(existsSync(target)).toBe(true);
      invocation.release();
      expect(existsSync(join(fixture!, "missing"))).toBe(false);
    } finally {
      invocation.release();
    }
  });
});
