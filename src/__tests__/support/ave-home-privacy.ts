import { afterEach, beforeEach, expect } from "vitest";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

/** Give a fresh fixture its boot input DACL rather than the test root's inherited ACL. */
export function protectAveHomeFixture(home: string): void {
  if (process.platform !== "win32") return;
  // SetAccessControl follows reparse points, so the resolved target must stay inside the run home.
  const target = realpathSync(home);
  const within = relative(realpathSync(process.env.AVE_TEST_RUN_HOME!), target);
  if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) throw new Error("Expected an isolated per-file home");
  const script = "$ErrorActionPreference='Stop'; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; "
    + "$s=[System.Security.AccessControl.DirectorySecurity]::new(); "
    + "$s.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;'+$u.Value+')',[System.Security.AccessControl.AccessControlSections]::Access); "
    + "[System.IO.Directory]::SetAccessControl($env:AVE_TEST_TARGET,$s)";
  execFileSync(resolve(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, stdio: "pipe", timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs,
      env: windowsPowerShellEnv({ ...process.env, AVE_TEST_TARGET: target }) });
}

export async function initializeAveHomeFixture(home: string): Promise<void> {
  const { configureHostResources } = await import("../../main/host-resources.js");
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const { ensureAveHomePrivate } = await import("../../shared/ave-home.js");
  const privacy = ensureAveHomePrivate(home);
  expect(privacy, JSON.stringify(privacy)).not.toMatchObject({ enforcement: "none" });
}

export function useVerifiedAveHomePrivacy(): void {
  beforeEach(async () => {
    const { configureHostResources } = await import("../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const { aveHome, setAveHomePrivacyAtBoot } = await import("../../shared/ave-home.js");
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: aveHome(), sid: "S-1-5-21-100-200-300-1001" });
  });
  afterEach(async () => {
    const { _resetAveHomePrivacyForTest } = await import("../../shared/ave-home.js");
    _resetAveHomePrivacyForTest();
  });
}
