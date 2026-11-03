/** The git the Windows installer downloads into `<install dir>\git` (build/install-windows-git.ps1): the official MinGit release, checked against
 * a pinned sha256 before it is placed. The folder sits in the per-machine install, so only an administrator can change it. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitRunnerOptions } from "./run-git.js";

export interface InstallerGitInstall {
  /** `cmd\git.exe`. */
  path: string;
  /** The MinGit root, holding `cmd\`, `mingw64\` and `usr\`. */
  root: string;
}

/** Where the installer puts git for a packaged Windows app, or null where no installer provides one (unpackaged runs, macOS, Linux). */
export function installerGitRoot(
  packaged: boolean,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return packaged && platform === "win32" ? join(dirname(execPath), "git") : null;
}

/** The installed copy, if the installer placed one. */
export function findInstallerGit(root: string | null): InstallerGitInstall | null {
  if (root === null) return null;
  const path = join(root, "cmd", "git.exe");
  return existsSync(path) ? { path, root } : null;
}

/** Runner settings for the copy. Its own system config is not read (§9.3), so it gets what that config would set; schannel makes it trust the
 * Windows certificate store, corporate roots included. */
export function installerRunnerOptions(install: InstallerGitInstall): Pick<GitRunnerOptions, "installerEnv" | "installerPathPrefix" | "installerConfig"> {
  return {
    installerEnv: { GIT_EXEC_PATH: join(install.root, "mingw64", "libexec", "git-core") },
    // Its https helper lives on the PATH prefix, not in GIT_EXEC_PATH.
    installerPathPrefix: [join(install.root, "mingw64", "bin"), join(install.root, "usr", "bin")].join(";"),
    installerConfig: { "http.sslBackend": "schannel" },
  };
}
