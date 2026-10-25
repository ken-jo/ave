/** Write one activation record per boot to the dedicated sandbox-gate channel. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

import { AuditLogger, type SandboxGateAuditEntry } from "../audit-logger.js";

let auditDir: string;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), "ave-sandbox-gate-tel-"));
});

afterEach(async () => {
  if (existsSync(auditDir)) await cleanupTmpDir(auditDir);
});

function readGateLines(): SandboxGateAuditEntry[] {
  const files = existsSync(auditDir)
    ? readdirSync(auditDir).filter((f) => f.endsWith(".sandbox-gate.jsonl"))
    : [];
  const out: SandboxGateAuditEntry[] = [];
  for (const f of files) {
    const raw = readFileSync(join(auditDir, f), "utf-8");
    for (const line of raw.split("\n").filter(Boolean)) {
      out.push(JSON.parse(line) as SandboxGateAuditEntry);
    }
  }
  return out;
}

describe("AuditLogger.logSandboxGate() — activation telemetry", () => {
  it("writes one record with platform / onSignal / outcome / reason and stamps timestamp+type", async () => {
    const logger = new AuditLogger(auditDir);
    logger.logSandboxGate({
      platform: "darwin",
      onSignal: "default-settings",
      outcome: "activate",
      reason: "deps-present",
    });
    await logger.flush();

    const entries = readGateLines();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.type).toBe("sandbox_gate");
    expect(e.platform).toBe("darwin");
    expect(e.onSignal).toBe("default-settings");
    expect(e.outcome).toBe("activate");
    expect(e.reason).toBe("deps-present");
    expect(new Date(e.timestamp).toISOString()).toBe(e.timestamp);
  });

  it("captures each terminal outcome shape (degrade / abort / skip)", async () => {
    const logger = new AuditLogger(auditDir);
    logger.logSandboxGate({
      platform: "linux",
      onSignal: "default-settings",
      outcome: "degrade",
      reason: "degrade-default-cannot-activate",
    });
    logger.logSandboxGate({
      platform: "linux",
      onSignal: "explicit-env",
      outcome: "abort",
      reason: "abort-explicit-cannot-activate",
    });
    logger.logSandboxGate({
      platform: "linux",
      onSignal: "off",
      outcome: "skip",
      reason: "gate-off",
    });
    await logger.flush();

    const entries = readGateLines();
    expect(entries.map((e) => e.outcome)).toEqual(["degrade", "abort", "skip"]);
    expect(entries.map((e) => e.onSignal)).toEqual([
      "default-settings",
      "explicit-env",
      "off",
    ]);
    expect(entries.every((e) => e.type === "sandbox_gate")).toBe(true);
  });

  it("swallows a failed telemetry write instead of surfacing it at boot", async () => {
    // Replace the audit directory with a file after construction so recursive mkdir cannot undo the failure.
    const gateDir = join(auditDir, "gate");
    const logger = new AuditLogger(gateDir);
    rmSync(gateDir, { recursive: true, force: true });
    writeFileSync(gateDir, "not a directory", "utf-8");

    // Telemetry write failures must not propagate into boot.
    expect(() =>
      logger.logSandboxGate({
        platform: "win32",
        onSignal: "explicit-env",
        outcome: "abort",
        reason: "abort-explicit-cannot-activate",
      }),
    ).not.toThrow();

    // Drain must resolve and count a dropped write, proving the failure was swallowed.
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(logger.getWriterStats().droppedWrites).toBe(1);
  });
});
