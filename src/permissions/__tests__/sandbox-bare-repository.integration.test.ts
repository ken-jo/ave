import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { cleanupAsrtSandboxAfterCommand, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";

describe.skipIf(process.platform !== "linux" || shouldSkipNativeSandboxTests())("native Linux bare-layout cleanup", () => {
  let root: string;
  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("does not manufacture missing bind targets and sweeps the layout only after exit", async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-bare-native-")));
    const work = join(root, "work");
    mkdirSync(work);
    await initializeRequiredSandbox({ allowedDomains: [] });
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: work, approvalSurface: "unavailable" } });
    try {
      const wrapped = await wrapToolCommand(`cd ${shellQuote(work)} && printf ordinary > ordinary && printf 'ref: refs/heads/main\\n' > HEAD && mkdir objects refs hooks && printf config > config`, {
        commandId: invocation.token, denyUnixSockets: true, filesystem: { allowWrite: [work], denyWrite: [] },
      });
      for (const name of ["HEAD", "objects", "refs", "config", "hooks"]) expect(existsSync(join(work, name))).toBe(false);
      const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: work, env: { ...process.env, ...wrapped.env }, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      if (result.error) throw result.error;
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(work, "HEAD"))).toBe(true);
    } finally {
      invocation.release();
      await cleanupAsrtSandboxAfterCommand();
    }
    for (const name of ["HEAD", "objects", "refs", "config", "hooks"]) expect(existsSync(join(work, name))).toBe(false);
    expect(readFileSync(join(work, "ordinary"), "utf8")).toBe("ordinary");
  });
});
