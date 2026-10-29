import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { NO_APPROVER_MESSAGE } from "../decision-pipeline.js";
import { PermissionManager } from "../permission-manager.js";

const MODES = ["strict", "default", "auto", "allow"] as const;
const PROTECTED_PROBES = ["git config core.hooksPath /tmp", "echo x > $AVE_HOME/config/settings.json"] as const;
let root: string;
let project: string;
let manager: PermissionManager;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "protected-write-floor-")));
  project = join(root, "project");
  mkdirSync(project);
  vi.stubEnv("AVE_HOME", join(root, "state"));
  manager = new PermissionManager(join(root, "permissions.json"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTmpDir(root);
});

function check(command: string, sandboxed: boolean, headless = false, environmentSnapshot?: Readonly<Record<string, string>>) {
  return manager.checkDetailed("bash", "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect: "bash", command, cwd: project },
    shellExecution: { runsSandboxed: sandboxed, ...(environmentSnapshot ? { environmentSnapshot } : {}) },
    headless,
  });
}

describe("protected shell mutation floor", () => {
  for (const mode of MODES) {
    for (const sandboxed of [false, true]) {
      for (const headless of [false, true]) {
        it.each(PROTECTED_PROBES)(`preserves the floor in ${mode}, sandboxed=${sandboxed}, headless=${headless}: %s`, command => {
          manager.setMode(mode);
          manager.setRules([{ pattern: "bash", action: "allow" }]);
          const result = check(command, sandboxed, headless);
          expect(result.pipelineRequest?.floor?.code).toBe("protected-path");
          expect(result.reviewer).toBeUndefined();
          if (headless) expect(result).toMatchObject({ decision: "deny", reason: NO_APPROVER_MESSAGE });
          else expect(result).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "protected-path" });
        });
      }
    }
    it(`keeps a literal and host-bound ordinary target equivalent in ${mode}`, () => {
      manager.setMode(mode);
      const literal = check("echo x > out.txt", true);
      const bound = check('echo x > "$PWD/out.txt"', true, false, Object.freeze({ PWD: project }));
      expect(bound.decision).toBe(literal.decision);
      expect(bound.reasonCode).toBe(literal.reasonCode);
      expect(bound.pipelineRequest?.floor).toBeUndefined();
      expect(bound.pipelineRequest?.shell?.unproven).toBe(false);
      expect(bound.pipelineRequest?.paths).toContainEqual(expect.objectContaining({ canonical: join(project, "out.txt"), effect: "write" }));
      expect(literal.decision).toBe(mode === "strict" ? "ask" : "allow");
    });
  }

  it("lets an explicit deny win over the possible protected-write floor", () => {
    manager.setMode("allow");
    manager.setRules([{ pattern: "bash", action: "deny" }]);
    expect(check(PROTECTED_PROBES[0], true)).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
  });

  it.each([
    "git config --get core.hooksPath",
    "git config --file .git/config remote.origin.url",
    "git config --type path remote.origin.url",
    "git remote -v",
    "git symbolic-ref HEAD",
    'cat "$INPUT"',
    'python -c "$CODE"',
  ])("does not invent a protected mutation for a query or opaque program: %s", command => {
    manager.setMode("allow");
    const result = check(command, true);
    expect(result.pipelineRequest?.floor).toBeUndefined();
    expect(result.forceModal).toBeUndefined();
  });
});
