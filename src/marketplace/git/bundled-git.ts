/** The git copy the installer ships (scripts/fetch-git.mjs). Packaged installs keep it read-only, so nothing is written inside it. */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GIT_RUNTIME_MARKER,
  GIT_RUNTIME_RESOURCE_DIR,
  GIT_RUNTIME_VERSION,
  gitRuntimeLayout,
  gitRuntimeTargetKey,
} from "../../../scripts/git-runtime-targets.mjs";
import type { GitRunnerOptions } from "./run-git.js";

export interface BundledGitInstall {
  /** The `git` binary. */
  path: string;
  /** The copy's root, holding its marker. */
  root: string;
}

const CA_BUNDLE = "bundled-git-ca-bundle.pem";

/** Where the copy for this system lives under the app resources, or null when the installer ships none (macOS). */
export function bundledGitRoot(resourcePath: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const key = gitRuntimeTargetKey(platform, arch);
  return key === null ? null : join(resourcePath, GIT_RUNTIME_RESOURCE_DIR, key);
}

/** The copy, if packaging staged and verified it: its marker names the pinned version and the binary exists. */
export async function findBundledGit(root: string | null, platform: NodeJS.Platform = process.platform): Promise<BundledGitInstall | null> {
  if (root === null) return null;
  let marker: { version?: unknown };
  try {
    marker = JSON.parse(await readFile(join(root, GIT_RUNTIME_MARKER), "utf8")) as { version?: unknown };
  } catch {
    return null;
  }
  const { executable } = gitRuntimeLayout(root, platform);
  if (marker.version !== GIT_RUNTIME_VERSION || !existsSync(executable)) return null;
  return { path: executable, root };
}

/** Runner settings for the copy. On Linux, corporate roots are appended to the shipped bundle in `caBundleDir`, rewritten on each call so a root added
 * to the OS store reaches the next run. */
export async function bundledRunnerOptions(
  install: BundledGitInstall,
  platform: NodeJS.Platform,
  corporateRootsPem: string | null,
  caBundleDir: string,
): Promise<Pick<GitRunnerOptions, "bundledEnv" | "bundledPathPrefix" | "bundledConfig">> {
  const layout = gitRuntimeLayout(install.root, platform);
  const env: Record<string, string> = { GIT_EXEC_PATH: layout.execPath };
  if (layout.shippedCaBundle) {
    if (corporateRootsPem) {
      const bundle = join(caBundleDir, CA_BUNDLE);
      const shipped = await readFile(layout.shippedCaBundle, "utf8");
      await writeFile(bundle, `${shipped.trimEnd()}\n${corporateRootsPem.trim()}\n`, { mode: 0o600 });
      env.GIT_SSL_CAINFO = bundle;
    } else {
      env.GIT_SSL_CAINFO = layout.shippedCaBundle;
    }
  }
  return {
    bundledEnv: env,
    ...(layout.pathPrefix.length > 0 ? { bundledPathPrefix: layout.pathPrefix.join(platform === "win32" ? ";" : ":") } : {}),
    bundledConfig: { ...layout.config },
  };
}
