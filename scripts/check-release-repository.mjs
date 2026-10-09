#!/usr/bin/env node
/**
 * Release gate: the repository a tag build publishes from must be the one
 * `package.json` `build.publish` names.
 *
 * electron-builder bakes `build.publish` into every installer's
 * `app-update.yml`. A tag built in a repository that `build.publish` does not
 * name would attach installers whose update feed points somewhere else, for
 * example at the previous owner after a transfer. The release workflow runs
 * this before the installer builds and again before it attaches anything.
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
  console.log(`[release-repository] package.json build.publish matches ${slug}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
