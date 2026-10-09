#!/usr/bin/env node
/**
 * Release gate: the repository a tag build publishes from must be the one
 * `package.json` `build.publish` names.
 *
 * electron-builder bakes `build.publish` into every installer's
 * `app-update.yml`. A tag built in a repository that `build.publish` does not
 * name would attach installers whose update feed points somewhere else, for
 * example at the previous owner after a transfer. The publish job runs this
 * before it attaches anything and fails closed on any mismatch, including a
 * missing `GITHUB_REPOSITORY` and a difference in letter case.
 */
import { pathToFileURL } from "node:url";
import { readRepositoryIdentity } from "./lib/repository-identity.mjs";

function fail(message) {
  throw new Error(`[release-repository] ${message}`);
}

export function assertReleaseRepository({ identity, repository }) {
  if (typeof repository !== "string" || repository.length === 0) {
    fail("GITHUB_REPOSITORY is not set");
  }
  if (repository !== identity.slug) {
    fail(
      `package.json build.publish names ${identity.slug}, but this build runs in ${repository}; ` +
        "its installers would update from the wrong repository",
    );
  }
  return identity.slug;
}

function main() {
  const slug = assertReleaseRepository({
    identity: readRepositoryIdentity(),
    repository: process.env.GITHUB_REPOSITORY,
  });
  console.log(`[release-repository] package.json build.publish matches ${slug}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
