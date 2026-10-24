import { t } from "../../i18n/index.js";
import { snapshotSandboxGitControls } from "../../permissions/sandbox-write-policy.js";
import type { SandboxWrapResult } from "../../permissions/asrt-sandbox.js";

/** A persistent shell cannot acquire new filesystem deny mounts between commands. */
export function terminalSandboxWindowNotice(): string | undefined {
  return process.platform === "linux" ? t("sandboxPolicy.terminalWindow") : undefined;
}

/** Additional controls need a new mount namespace; never advance this baseline. */
export function prepareTerminalGitPolicyCheck(
  initial: SandboxWrapResult["filesystemPolicy"],
  initialControls?: SandboxWrapResult["gitControlSnapshot"],
): (() => boolean) | undefined {
  if (process.platform !== "linux") return undefined;
  if (initial === undefined) throw new Error("Linux terminal sandbox filesystem policy is unavailable");
  if (initialControls === undefined) throw new Error("Linux terminal sandbox Git control snapshot is unavailable");
  const roots = initial.allowWrite.map(path => typeof path === "string" ? path : path.path);
  return () => {
    const currentControls = snapshotSandboxGitControls(roots, initialControls);
    if (currentControls.replacedMarkers.size > 0) return true;
    for (const [path, current] of currentControls.directories) {
      if (current?.kind !== "link") continue;
      const previous = initialControls.directories.get(path);
      if (previous === undefined || previous.dev !== current.dev || previous.ino !== current.ino || previous.kind !== current.kind) return true;
    }
    for (const [path, current] of currentControls.entries) {
      if (current === undefined) continue;
      const previous = initialControls.entries.get(path);
      if (previous === undefined || previous.dev !== current.dev || previous.ino !== current.ino || previous.kind !== current.kind) return true;
    }
    return false;
  };
}
