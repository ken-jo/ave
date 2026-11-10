import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { setWindowsIsolationForTesting } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

let root: string;
let releasePath: string;
let callsPath: string;
let pending: Promise<void> | undefined;
const watchers: Array<() => void> = [];
const ORIGINAL_PLATFORM = process.platform;

function calls(): string[] {
  return existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n") : [];
}

async function waitForStamp(): Promise<void> {
  if (calls().includes("stamp")) return;
  await new Promise<void>(resolve => {
    const watcher = watch(root, () => {
      if (!calls().includes("stamp")) return;
      watcher.close();
      resolve();
    });
    watchers.push(() => watcher.close());
    if (calls().includes("stamp")) {
      watcher.close();
      resolve();
    }
  });
}

function fullConfig(): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [join(root, "private")], denyWrite: [], allowWrite: [] },
    windows: { srtWin: { path: "configured-helper" }, proxyPortRange: [43000, 43099] },
  };
}

beforeEach(async () => {
  setProcessPlatform("win32");
  root = mkdtempSync(join(tmpdir(), "ave-windows-initialization-"));
  releasePath = join(root, "release");
  callsPath = join(root, "calls");
  const script = join(root, "acl-helper.mjs");
  writeFileSync(script, [
    'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
    `const step = process.argv[3];`,
    `if (process.argv[2] === "acl") appendFileSync(${JSON.stringify(callsPath)}, step + "\\n");`,
    `if (step === "stamp") {`,
    `  const timer = setInterval(() => {`,
    `    if (!existsSync(${JSON.stringify(releasePath)})) return;`,
    `    clearInterval(timer);`,
    `    process.exitCode = Number(readFileSync(${JSON.stringify(releasePath)}, "utf8"));`,
    `  }, 10);`,
    `} else if (step === "status") {`,
    `  process.stdout.write(JSON.stringify({ user: { exists: true, sid: "S-1-5-21-123" }, cred_present: true }));`,
    `} else if (step === "verify") {`,
    `  process.stdout.write(JSON.stringify({ target: "127.0.0.1:1", egress_probe: "blocked" }));`,
    `} else if (step === "recover") {`,
    `  process.stdout.write(JSON.stringify({ deadBrokers: 0, acesRevoked: 0 }));`,
    `} else if (step === "revoke" || step === "restore") {`,
    `  process.stdout.write("[]");`,
    `}`,
  ].join("\n"));
  setWindowsIsolationForTesting({
    exe: process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath,
    prependArgs: [script],
  });
  const config = fullConfig();
  await SandboxManager.initialize({ ...config, windows: { ...config.windows, externalConfinement: "embedder" } } as SandboxRuntimeConfig);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const close of watchers.splice(0)) close();
  writeFileSync(releasePath, "0");
  await pending?.catch(() => {});
  pending = undefined;
  await SandboxManager.reset();
  setWindowsIsolationForTesting(undefined);
  setProcessPlatform(ORIGINAL_PLATFORM);
  rmSync(root, { recursive: true, force: true });
});

describe("Windows isolation after proxy startup", () => {
  it("keeps proxy startup and the event loop independent of a pending stamp, then upgrades without rebinding", async () => {
    const proxyPort = SandboxManager.getProxyPort();
    pending = SandboxManager.initializeWindowsIsolation(fullConfig());
    await waitForStamp();
    expect(SandboxManager.getProxyPort()).toBe(proxyPort);
    expect(SandboxManager.getConfig()?.windows).toMatchObject({ externalConfinement: "embedder" });
    await expect(SandboxManager.wrapWithSandboxArgv("echo safe")).rejects.toThrow("externalConfinement");
    const current = SandboxManager.getConfig();
    if (current === undefined) throw new Error("Proxy configuration is unavailable");
    SandboxManager.updateConfig({ ...current, network: { ...current.network, allowedDomains: ["updated.example.invalid"] } });
    let ticked = false;
    await new Promise<void>(resolve => setImmediate(() => { ticked = true; resolve(); }));
    expect(ticked).toBe(true);
    writeFileSync(releasePath, "0");
    await pending;
    expect(SandboxManager.getConfig()?.windows).not.toHaveProperty("externalConfinement");
    expect(SandboxManager.getConfig()?.network.allowedDomains).toEqual(["updated.example.invalid"]);
    expect(SandboxManager.getProxyPort()).toBe(proxyPort);
    expect(calls()).toEqual(["recover", "stamp"]);
  });

  it("retains the proxy and its wrap refusal after a late stamp failure", async () => {
    const proxyPort = SandboxManager.getProxyPort();
    pending = SandboxManager.initializeWindowsIsolation(fullConfig());
    const outcome = expect(pending).rejects.toMatchObject({ code: "acl_stamp_failed" });
    await waitForStamp();
    writeFileSync(releasePath, "2");
    await outcome;
    expect(SandboxManager.getConfig()?.windows).toMatchObject({ externalConfinement: "embedder" });
    expect(SandboxManager.getProxyPort()).toBe(proxyPort);
    await expect(SandboxManager.wrapWithSandboxArgv("echo safe")).rejects.toThrow("externalConfinement");
    expect(calls()).toEqual(["recover", "stamp", "revoke", "restore"]);
  });

  it("releases a pending session before reset finishes and refuses its late promotion", async () => {
    pending = SandboxManager.initializeWindowsIsolation(fullConfig());
    const outcome = expect(pending).rejects.toThrow("session ended");
    await waitForStamp();
    const resetting = SandboxManager.reset();
    writeFileSync(releasePath, "0");
    await outcome;
    await resetting;
    expect(SandboxManager.getConfig()?.windows).toMatchObject({ externalConfinement: "embedder" });
    expect(SandboxManager.getProxyPort()).toBeUndefined();
    expect(calls()).toEqual(["recover", "stamp", "revoke", "restore"]);
  });

  it("times out a hung stamp at the existing ceiling while retaining proxy-only confinement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    pending = SandboxManager.initializeWindowsIsolation(fullConfig());
    const outcome = expect(pending).rejects.toMatchObject({ code: "srt_win_timeout" });
    await waitForStamp();
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    expect(SandboxManager.getConfig()?.windows).toMatchObject({ externalConfinement: "embedder" });
    await expect(SandboxManager.wrapWithSandboxArgv("echo safe")).rejects.toThrow("externalConfinement");
    expect(calls()).toEqual(["recover", "stamp", "revoke", "restore"]);
  });

  it("shares concurrent reset completion and refuses promotion until its single teardown settles", async () => {
    pending = SandboxManager.initializeWindowsIsolation(fullConfig());
    const outcome = expect(pending).rejects.toThrow("session ended");
    await waitForStamp();
    const first = SandboxManager.reset();
    const second = SandboxManager.reset();
    expect(second).toBe(first);
    await expect(SandboxManager.initializeWindowsIsolation(fullConfig())).rejects.toThrow("fresh proxy-only session");
    writeFileSync(releasePath, "0");
    await outcome;
    await Promise.all([first, second]);
    expect(SandboxManager.getProxyPort()).toBeUndefined();
    expect(calls()).toEqual(["recover", "stamp", "revoke", "restore"]);
  });
});
