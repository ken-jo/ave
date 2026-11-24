import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resolveShell, ShellMismatchError, __resetShellResolverCache } from "../shell-resolver.js";

// Unmocked on purpose: unlike shell-resolver.test.ts this file does NOT mock node:child_process, so it
// spawns the real interpreter on the actual ACL host. It proves the P2 floor end to end — the admin-owned
// C:\Program Files\Git is the only Program Files root the resolver trusts, and nothing env-derived can
// stand in for it (the candidate roots are hardcoded, never read from the environment).
describe("shell-resolver win32 trusted root", () => {
  afterEach(() => __resetShellResolverCache());

  it.runIf(process.platform === "win32")("selects the real admin-owned Git bash when installed, never an env-derived root", () => {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const present = existsSync(gitBash);
    __resetShellResolverCache();
    let resolved: string | undefined;
    let error: unknown;
    try { resolved = resolveShell("bash").cmd; } catch (err) { error = err; }
    if (present) {
      // Git for Windows is installed at the admin-owned root, so it is the selected interpreter.
      expect(error, `Git present at ${gitBash} but resolveShell threw: ${String(error)}`).toBeUndefined();
      expect(resolved, "Git present → admin-owned root selected").toBe(gitBash);
    } else {
      // No Git install: the resolver falls through to a PATH lookup or reports a missing shell. It must
      // never select a Program Files path, because that root is never derived from the environment.
      if (error !== undefined) expect(error, "Git absent → missing-shell report").toBeInstanceOf(ShellMismatchError);
      else expect(resolved, "Git absent → PATH fallback, not a Program Files path").not.toMatch(/Program Files/i);
    }
  });
});
