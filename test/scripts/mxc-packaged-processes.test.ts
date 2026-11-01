import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../src/shared/tool-timeout-policy.js";
// @ts-expect-error standalone probe utilities do not emit declarations
import { packagedMainArguments, writeProbeJson } from "../../tools/mxc-probes/packaged-processes.mjs";

async function readObservation(file: string) {
  const until = Date.now() + TOOL_TIMEOUT_POLICY.mxcRequestTransportMs;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await pause(TOOL_TIMEOUT_POLICY.processGroupPollMs);
  }
  throw new Error("Fixture observation deadline exceeded");
}

describe("probe identity journals", () => {
  it("publishes complete observations atomically and rejects names outside the journal directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ave-journal-"));
    try {
      await writeProbeJson(root, "process.json", { pid: 123, nonce: "first" });
      await writeProbeJson(root, "process.json", { pid: 123, nonce: "second" });
      expect(JSON.parse(await readFile(path.join(root, "process.json"), "utf8"))).toEqual({ pid: 123, nonce: "second" });
      expect(await readdir(root)).toEqual(["process.json"]);
      await expect(writeProbeJson(root, "../other.json", {})).rejects.toThrow("Invalid probe journal name");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("holds the plain stream fixture for identity confirmation before byte transfer and EOF", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ave-stream-fixture-"));
    const token = randomBytes(16).toString("hex");
    const fixture = path.join(root, "fixture.mjs");
    await copyFile("tools/mxc-probes/packaged-fixture.mjs", fixture);
    await copyFile("tools/mxc-probes/packaged-processes.mjs", path.join(root, "packaged-processes.mjs"));
    const child = spawn(process.execPath, [fixture, "echo", token, String(TOOL_TIMEOUT_POLICY.processGroupPollMs)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const completion = once(child, "close");
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", (bytes: Buffer) => output.push(bytes));
    child.stderr.on("data", (bytes: Buffer) => errors.push(bytes));
    try {
      expect(await readObservation(path.join(root, "process.json"))).toEqual({ token, pid: child.pid, role: "echo" });
      expect(Buffer.concat(output).length).toBe(0);
      const nonce = randomUUID();
      await writeProbeJson(root, `challenge-${child.pid}.json`, { nonce });
      expect(await readObservation(path.join(root, `ack-${child.pid}.json`))).toEqual({ token, nonce, pid: child.pid });
      expect(Buffer.concat(output).length).toBe(0);
      const payload = randomBytes(65536);
      await writeProbeJson(root, "go.json", {});
      child.stdin.end(payload);
      expect(await completion).toEqual([0, null]);
      expect(Buffer.concat(output)).toEqual(payload);
      expect(Buffer.concat(errors).toString()).toBe("fixture-input-eof\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await completion; }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs cancellation in a dedicated fixture without launching a grandchild", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ave-cancel-fixture-"));
    const token = randomBytes(16).toString("hex");
    const fixture = path.join(root, "fixture.mjs");
    await copyFile("tools/mxc-probes/packaged-fixture.mjs", fixture);
    await copyFile("tools/mxc-probes/packaged-processes.mjs", path.join(root, "packaged-processes.mjs"));
    const child = spawn(process.execPath, [fixture, "cancel", token, String(TOOL_TIMEOUT_POLICY.processGroupPollMs)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "pipe",
    });
    const completion = once(child, "close");
    try {
      expect(await readObservation(path.join(root, "process.json"))).toEqual({ token, pid: child.pid, role: "cancel" });
      const nonce = randomUUID();
      await writeProbeJson(root, `challenge-${child.pid}.json`, { nonce });
      expect(await readObservation(path.join(root, `ack-${child.pid}.json`))).toEqual({ token, nonce, pid: child.pid });
      expect(await readdir(root)).not.toContain("grandchild.json");
      const main = await readFile("tools/mxc-probes/packaged-main.ts", "utf8");
      expect(main).toContain('path.join(runDirectory, "fixture.mjs"), mode, token');
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await completion; }
      await rm(root, { recursive: true, force: true });
    }
  });
});


describe("independent pin-inspector routing", () => {
  it("keeps the original observer package distinct from the mutable copied package", async () => {
    const directory = path.resolve(tmpdir(), "probe-run", "planted");
    const original = path.resolve(tmpdir(), "trusted-package", "Ave.exe");
    const arguments_ = packagedMainArguments([directory, "echo", "a".repeat(32), original]);
    expect(arguments_.observerExecutable).toBe(original);
    expect(arguments_.runDirectory).toBe(directory);
    for (const argv of [[directory, "echo", "a".repeat(32)], [directory, "echo", "a".repeat(32), "relative.exe"]]) {
      expect(() => packagedMainArguments(argv)).toThrow("Invalid packaged probe arguments");
    }
    const main = await readFile("tools/mxc-probes/packaged-main.ts", "utf8");
    const driver = await readFile("tools/mxc-probes/packaged.mjs", "utf8");
    expect(main).toContain("openPackagedObserver(observerExecutable, PINS)");
    expect(main).toContain("await spawnMxcExtensionProcessForDiagnostics(request,");
    expect(driver).toContain('randomBytes(16).toString("hex"), budgets, original)');
    expect(driver).not.toContain("rm(planted)");
  });
});
