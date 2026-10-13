#!/usr/bin/env node
/**
 * Release gate: the repository a tag build releases from must be the one
 * `package.json` `repository` names.
 *
 * A tag built in a repository that `package.json` does not name (a fork, or
 * the previous owner after a transfer) would draft its GitHub Release record
 * there and upload installers to the update channel from there. The release
 * workflow runs this before the installer builds and again in each publishing
 * job before it uploads or attaches anything.
 *
 * This file is only an entry point and runs unconditionally: there is no
 * "am I the main module" check that a symlinked or relative invocation could
 * get wrong and skip silently. The logic lives in lib/repository-identity.mjs.
 */
import { assertReleaseRepository, readRepositoryIdentity } from "./lib/repository-identity.mjs";

try {
  const slug = assertReleaseRepository({
    identity: readRepositoryIdentity(),
    repository: process.env.GITHUB_REPOSITORY,
  });
  console.log(`[release-repository] package.json repository matches ${slug}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
