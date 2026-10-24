import { t } from "../../i18n/index.js";
import { buildMandatorySandboxWritePolicy } from "../../permissions/sandbox-write-policy.js";
import type { SandboxWrapResult } from "../../permissions/asrt-sandbox.js";

/** A persistent shell cannot acquire new filesystem deny mounts between commands. */
export function terminalSandboxWindowNotice(): string | undefined {
  return process.platform === "linux" ? t("sandboxPolicy.terminalWindow") : undefined;
}

/** Additional controls need a new mount namespace; never advance this baseline. */
export function prepareTerminalGitPolicyCheck(
  writeRoots: readonly string[], initial: SandboxWrapResult["filesystemPolicy"],
): (() => boolean) | undefined {
  if (process.platform !== "linux") return undefined;
  if (initial === undefined) throw new Error("Linux terminal sandbox filesystem policy is unavailable");
  const roots = initial.allowWrite.map(path => typeof path === "string" ? path : path.path);
  const denies = new Set(initial.denyWrite.map(path => typeof path === "string" ? path : path.path));
  return () => {
    const current = buildMandatorySandboxWritePolicy(writeRoots);
    return roots.some(root => !current.allowWrite.includes(root))
      || current.denyWrite.some(path => !denies.has(typeof path === "string" ? path : path.path));
  };
}
