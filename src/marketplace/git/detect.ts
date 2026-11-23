import type { GitRuntimeStatus } from "../../shared/git-runtime.js";
import type { GitVersion } from "../../shared/git-version.js";
import { discoverHostGitAsync, type GitDiscovery, type VerifiedInstallerGit } from "../../shared/host-git-executable.js";

export type GitExecutable = { path: string; version: GitVersion } & (
  | { kind: "installer"; installer: VerifiedInstallerGit }
  | { kind: "system" }
);

interface TooOldGit {
  path: string;
  version: string;
}

export type GitDetection =
  | { state: "ready"; git: GitExecutable; systemTooOld?: TooOldGit }
  | { state: "missing"; systemTooOld?: TooOldGit };

export async function detectGitRuntime(installerRoot: string | null): Promise<GitDetection> {
  return classifyGitDiscovery(await discoverHostGitAsync(installerRoot));
}

export function classifyGitDiscovery({ git, systemTooOld }: GitDiscovery): GitDetection {
  const status = systemTooOld ? { systemTooOld } : {};
  if (!git) return { state: "missing", ...status };
  const { path, version, installer } = git;
  return {
    state: "ready",
    git: installer ? { kind: "installer", path, version, installer } : { kind: "system", path, version },
    ...status,
  };
}

export function gitRuntimeStatus(detection: GitDetection, installerProvides: boolean): GitRuntimeStatus {
  return {
    state: detection.state,
    active: detection.state === "ready" ? { kind: detection.git.kind, version: detection.git.version.text } : null,
    systemTooOld: detection.systemTooOld ? { version: detection.systemTooOld.version } : null,
    installerProvides,
  };
}
