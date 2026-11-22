import { join } from "node:path";
import type { InstallerGitInstall } from "../../shared/host-git-executable.js";
import type { GitRunnerOptions } from "./run-git.js";

/** Runner settings for the copy. Its own system config is not read (§9.3), so schannel is passed here: the Windows certificate store, corporate
 * roots included, is the only trust source. */
export function installerRunnerOptions(install: InstallerGitInstall): Pick<GitRunnerOptions, "installerEnv" | "installerPathPrefix" | "installerConfig"> {
  return {
    installerEnv: { GIT_EXEC_PATH: join(install.root, install.prefix, "libexec", "git-core") },
    // Its https helper lives on the PATH prefix, not in GIT_EXEC_PATH.
    installerPathPrefix: [join(install.root, install.prefix, "bin"), join(install.root, "usr", "bin")].join(";"),
    installerConfig: { "http.sslBackend": "schannel" },
  };
}
