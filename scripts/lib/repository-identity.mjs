import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Package repository metadata is the authority for release identity; the update feed is separate.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const REPO = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u;
const GITHUB_GIT_URL = /^git\+https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/u;

function fail(message) {
  throw new Error(`[repository-identity] ${message}`);
}

export function repositoryIdentity(packageJson) {
  const repository = packageJson?.repository;
  if (repository === null || typeof repository !== "object" || Array.isArray(repository)) {
    fail('package.json repository must be an object { "type": "git", "url": "git+https://github.com/<owner>/<repo>.git" }');
  }
  if (repository.type !== "git") {
    fail(`package.json repository.type must be "git" (got ${JSON.stringify(repository.type)})`);
  }
  const match = typeof repository.url === "string" ? GITHUB_GIT_URL.exec(repository.url) : null;
  if (match === null) {
    fail(
      `package.json repository.url must be git+https://github.com/<owner>/<repo>.git (got ${JSON.stringify(repository.url)})`,
    );
  }
  const [, owner, repo] = match;
  if (!OWNER.test(owner)) {
    fail(`package.json repository.url does not name a GitHub owner (got ${JSON.stringify(owner)})`);
  }
  if (!REPO.test(repo)) {
    fail(`package.json repository.url does not name a GitHub repository (got ${JSON.stringify(repo)})`);
  }
  return Object.freeze({ owner, repo, slug: `${owner}/${repo}` });
}

export function readRepositoryIdentity(root = ROOT) {
  return repositoryIdentity(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));
}

// Require an exact repository identity; missing values and case differences fail.
export function assertReleaseRepository({ identity, repository }) {
  if (typeof repository !== "string" || repository.length === 0) {
    throw new Error("[release-repository] GITHUB_REPOSITORY is not set");
  }
  if (repository !== identity.slug) {
    throw new Error(
      `[release-repository] package.json repository names ${identity.slug}, but this build runs in ${repository}; ` +
        "its release would be recorded and uploaded from a repository the package does not name",
    );
  }
  return identity.slug;
}
