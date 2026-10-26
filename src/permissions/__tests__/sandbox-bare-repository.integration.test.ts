import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { getLocale, setLocale } from "../../i18n/index.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { cleanupAsrtSandboxAfterCommand, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { sandboxQuarantineRoot } from "../sandbox-quarantine.js";

describe.skipIf(process.platform !== "linux" || shouldSkipNativeSandboxTests())("native Linux bare-layout cleanup", () => {
  let root: string;
  let previousLocale: ReturnType<typeof getLocale>;
  beforeEach(() => {
    previousLocale = getLocale();
    setLocale("en");
  });
  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    vi.unstubAllEnvs();
    setLocale(previousLocale);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("does not manufacture missing bind targets and quarantines the layout after exit", async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-bare-native-")));
    const work = join(root, "work");
    mkdirSync(work);
    vi.stubEnv("AVE_HOME", join(root, "host"));
    await initializeRequiredSandbox({ allowedDomains: [] });
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: work, approvalSurface: "unavailable" } });
    const protectedTarget = join(sandboxQuarantineRoot(), "command-created");
    try {
      const wrapped = await wrapToolCommand(`cd ${shellQuote(work)} && printf ordinary > ordinary && printf 'ref: refs/heads/main\\n' > HEAD && mkdir objects refs hooks && printf config > config && if printf tampered > ${shellQuote(protectedTarget)}; then exit 97; fi`, {
        commandId: invocation.token, denyUnixSockets: true, filesystem: { allowWrite: [root, work], denyWrite: [] },
      });
      for (const name of ["HEAD", "objects", "refs", "config", "hooks"]) expect(existsSync(join(work, name))).toBe(false);
      const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: work, env: { ...process.env, ...wrapped.env }, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      if (result.error) throw result.error;
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(protectedTarget)).toBe(false);
      expect(existsSync(join(work, "HEAD"))).toBe(true);
      invocation.release();
      const outcome = await wrapped.cleanupCompleted;
      expect(outcome?.failure).toBeUndefined();
      expect(outcome?.notice).toContain("moved to quarantine (not deleted)");
      expect(outcome?.notice).toContain(JSON.stringify(join(work, "HEAD")));
      expect(outcome?.notice).toContain(sandboxQuarantineRoot());
    } finally {
      invocation.release();
      await cleanupAsrtSandboxAfterCommand();
    }
    for (const name of ["HEAD", "objects", "refs", "config", "hooks"]) expect(existsSync(join(work, name))).toBe(false);
    expect(readFileSync(join(work, "ordinary"), "utf8")).toBe("ordinary");
    const entries = readdirSync(sandboxQuarantineRoot()).flatMap(slot =>
      readdirSync(join(sandboxQuarantineRoot(), slot)).map(name => join(sandboxQuarantineRoot(), slot, name)));
    expect(entries).toHaveLength(5);
    const head = entries.find(name => name.endsWith("-HEAD"));
    expect(readFileSync(head!, "utf8")).toBe("ref: refs/heads/main\n");
  });
});
