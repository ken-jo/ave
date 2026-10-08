import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const {
  launchSucceeded,
  readProductionLogsSince,
  reachedBootReadiness,
  snapshotProductionLogs,
} = require("../../scripts/lib/packaged-smoke-readiness.mjs") as {
  launchSucceeded: (outcome: { ready: boolean; timedOut: boolean; code: number | null; signal: string | null }) => boolean;
  readProductionLogsSince: (home: string, snapshot: Map<string, number>) => string;
  reachedBootReadiness: (logText: string) => boolean;
  snapshotProductionLogs: (home: string) => Map<string, number>;
};

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("packaged launch readiness", () => {
  it.each([
    ["exit zero before boot", { ready: false, timedOut: false, code: 0, signal: null }, false],
    ["boot then timeout", { ready: true, timedOut: true, code: null, signal: "SIGTERM" }, true],
    ["boot then exit zero", { ready: true, timedOut: false, code: 0, signal: null }, true],
    ["boot then exit non-zero", { ready: true, timedOut: false, code: 1, signal: null }, false],
  ] as const)("%s", (_name, outcome, accepted) => {
    expect(launchSucceeded(outcome)).toBe(accepted);
  });

  it("requires a fresh readiness line for the upgrade launch", () => {
    const home = mkdtempSync(join(tmpdir(), "packaged-readiness-"));
    homes.push(home);
    const logs = join(home, "logs");
    mkdirSync(logs);
    const log = join(logs, "ave-2026-09-28.log");
    writeFileSync(log, '{"msg":"boot: ready (38 tools, 0 plugins, 0 mcp)"}\n');

    const beforeUpgrade = snapshotProductionLogs(home);
    appendFileSync(log, '{"msg":"boot: starting"}\n');
    expect(reachedBootReadiness(readProductionLogsSince(home, beforeUpgrade))).toBe(false);

    appendFileSync(log, '{"msg":"boot: ready (38 tools, 0 plugins, 0 mcp)"}\n');
    expect(reachedBootReadiness(readProductionLogsSince(home, beforeUpgrade))).toBe(true);
  });
});
