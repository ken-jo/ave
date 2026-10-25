#!/usr/bin/env node
// Releases must come from the repository named by package metadata.
// Run unconditionally so invocation spelling cannot skip the gate.
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
