import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkShellPermission, distinctPathArguments } from "../../__tests__/support/permission-lane.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, type PermissionRule } from "../permission-manager.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import * as shellPolicy from "../rules/shell-prefix-policy.js";
import * as powerShellPolicy from "../rules/powershell-exfiltration.js";
import * as shellFloors from "../rules/shell-exfiltration.js";
import * as riskClassifier from "../reviewer/risk-classifier.js";
import * as shellDirectory from "../shell-working-directory-identity.js";
import { MAX_LITERAL_COMMAND_LENGTH } from "../rules/shell-prefix-values.js";
import { normalizeRuleSpecifierInput } from "../rules/rule-specifier.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";

const LITERAL_INPUT_LIMIT = 2_000;
const FLOOR_INPUT_LIMIT = 8_000;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
let cwd: string;
let stateRoot: string;
let manager: PermissionManager;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "permission-lane-")));
  stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "permission-lane-state-")));
  vi.stubEnv("AVE_HOME", stateRoot);
  __resetSessionStoreForTest();
  manager = new PermissionManager(join(stateRoot, "permissions.json"));
  manager.setMode("allow");
});

afterEach(() => {
  __resetSessionStoreForTest();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});


const TIMING_CASES = (["bash", "powershell"] as const).flatMap((dialect) =>
  [false, true].flatMap((runsSandboxed) => [10_000, 100_000].map((length) => ({ dialect, runsSandboxed, length }))),
);

describe("complete manager timing", () => {
  it.each(TIMING_CASES)("$dialect sandboxed=$runsSandboxed length=$length", ({ dialect, runsSandboxed, length }) => {
    const command = distinctPathArguments(length);
    expect(command.length).toBe(length);
    const spies = analysisSpies();
    try {
      const start = performance.now();
      const result = checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed);
      const elapsed = performance.now() - start;
      process.stdout.write(`permission lane timing ${dialect} sandboxed=${runsSandboxed} chars=${length} decision=${result.decision} layer=${result.layer} modal=${result.forceModal === true} ms=${elapsed.toFixed(3)}\n`);
      expect(result.reason).toEqual(expect.any(String));
      expect(elapsed).toBeLessThan(5_000);
      if (!runsSandboxed) expect(result).toMatchObject({ decision: "ask", layer: 6 });
      if (MAX_LITERAL_COMMAND_LENGTH === LITERAL_INPUT_LIMIT) {
        expect(spies).toHaveLength(10);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(elapsed).toBeLessThan(250);
        if (runsSandboxed) expect(result).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

function analysisSpies() {
  const spies = [
    vi.spyOn(shellFloors, "parseShellFloorCommand"),
    vi.spyOn(powerShellPolicy, "inspectPowerShellCommand"),
    vi.spyOn(powerShellPolicy, "powerShellRuleShape"),
    vi.spyOn(powerShellPolicy, "inspectPowerShellVisibleText"),
    vi.spyOn(shellFloors, "shellExfiltrationSignal"),
    vi.spyOn(shellFloors, "shellSensitivePathSignal"),
    vi.spyOn(riskClassifier, "isDestructiveShellText"),
    vi.spyOn(shellDirectory, "captureShellWorkingDirectoryIdentity"),
    vi.spyOn(shellPolicy, "parseShellCommand"),
  ];
  if ("inspectShellCommand" in shellFloors) spies.push(vi.spyOn(shellFloors, "inspectShellCommand"));
  return spies;
}

function literalCommand(length: number): string {
  return `printf${" ".repeat(length - "printf".length - "ready".length)}ready`;
}

function seedExactAllow(command: string, dialect: ShellRuleDialect): void {
  const kind = dialect === "bash" ? "Bash" : "PowerShell";
  manager.setRules([
    { pattern: dialect, action: "allow" },
    withCurrentShellRuleVersion<PermissionRule>({ pattern: normalizeRuleSpecifierInput(`${kind}(${command})`), action: "allow" }),
  ]);
}

describe.each(["bash", "powershell"] as const)("literal lane bounds (%s)", (dialect) => {
  it.each([LITERAL_INPUT_LIMIT - 1, LITERAL_INPUT_LIMIT, LITERAL_INPUT_LIMIT + 1])("checks the exact-rule boundary at %i characters", (length) => {
    expect(MAX_LITERAL_COMMAND_LENGTH).toBe(LITERAL_INPUT_LIMIT);
    const command = literalCommand(length);
    seedExactAllow(command, dialect);
    const spies = analysisSpies();
    try {
      const result = checkShellPermission(manager, cwd, SESSION_ID, command, dialect, false);
      if (length > LITERAL_INPUT_LIMIT) {
        expect(result).toMatchObject({ decision: "ask", layer: 6 });
        expect(checkShellPermission(manager, cwd, SESSION_ID, command, dialect, false, true)).toMatchObject({ decision: "deny", layer: 6 });
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ decision: "allow", layer: 3 });
        expect(spies[dialect === "bash" ? 0 : 1]).toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe.each(["bash", "powershell"] as const)("sandbox floor bounds (%s)", (dialect) => {
  it.each([FLOOR_INPUT_LIMIT - 1, FLOOR_INPUT_LIMIT, FLOOR_INPUT_LIMIT + 1])("checks the floor boundary at %i characters", (length) => {
    const command = literalCommand(length);
    seedExactAllow(command, dialect);
    const spies = analysisSpies();
    // Keep this test about input routing; actual work exhaustion has its own refusal case.
    if (dialect === "bash") vi.mocked(shellFloors.inspectShellCommand).mockReturnValue({ outcome: "static-complete", sensitive: null, exfiltration: null });
    else vi.mocked(powerShellPolicy.inspectPowerShellCommand).mockReturnValue({ outcome: "static-complete", sensitive: null, exfiltration: null });
    try {
      const result = checkShellPermission(manager, cwd, SESSION_ID, command, dialect, true);
      if (length > FLOOR_INPUT_LIMIT) {
        expect(result).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ decision: "allow", layer: 3 });
        expect(result.forceModal).not.toBe(true);
        expect(dialect === "bash" ? shellFloors.inspectShellCommand : powerShellPolicy.inspectPowerShellCommand).toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe.each(["bash", "powershell"] as const)("floor work exhaustion (%s)", (dialect) => {
  it.each([false, true])("stops analysis despite stored allows when sandboxed=%s", (runsSandboxed) => {
    const command = "printf ready";
    seedExactAllow(command, dialect);
    const inspect = dialect === "bash"
      ? vi.spyOn(shellFloors, "inspectShellCommand")
      : vi.spyOn(powerShellPolicy, "inspectPowerShellCommand");
    const bashParse = vi.spyOn(shellPolicy, "parseShellCommand");
    const floorParse = vi.spyOn(shellFloors, "parseShellFloorCommand");
    const powerShellShape = vi.spyOn(powerShellPolicy, "powerShellRuleShape");
    const destructive = vi.spyOn(riskClassifier, "isDestructiveShellText");
    let parsesBeforeBudget = 0;
    let floorParsesBeforeBudget = 0;
    inspect.mockImplementation(() => {
      parsesBeforeBudget = bashParse.mock.calls.length;
      floorParsesBeforeBudget = floorParse.mock.calls.length;
      return { outcome: "unproven", sensitive: null, exfiltration: null, analysisLimited: true };
    });
    try {
      expect(checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed)).toMatchObject(runsSandboxed
        ? { decision: "ask", layer: 2, forceModal: true }
        : { decision: "ask", layer: 6 });
      expect(bashParse).toHaveBeenCalledTimes(parsesBeforeBudget);
      expect(floorParse).toHaveBeenCalledTimes(floorParsesBeforeBudget);
      if (!runsSandboxed) expect(checkShellPermission(manager, cwd, SESSION_ID, command, dialect, false, true)).toMatchObject({ decision: "deny", layer: 6 });
      expect(bashParse).toHaveBeenCalledTimes(parsesBeforeBudget);
      expect(floorParse).toHaveBeenCalledTimes(floorParsesBeforeBudget);
      expect(powerShellShape).not.toHaveBeenCalled();
      expect(destructive).not.toHaveBeenCalled();
    } finally {
      inspect.mockRestore();
      bashParse.mockRestore();
      floorParse.mockRestore();
      powerShellShape.mockRestore();
      destructive.mockRestore();
    }
  });
});
