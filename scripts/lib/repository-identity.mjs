import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This repository's GitHub identity.
 *
 * `package.json` `build.publish` is the one place that names it.
 * electron-builder writes that entry into the packaged `app-update.yml`, so it
 * is the feed every installed app updates from. Anything else that must name
 * this repository reads it here or is held to it by
 * `test/scripts/repository-identity.test.ts`.
 *
 * The rule is strict: exactly one `github` publish entry. A second entry would
 * be a second feed that nothing here checks, so it is refused rather than
 * ignored.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const REPO = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u;

function fail(message) {
  throw new Error(`[repository-identity] ${message}`);
}

export function repositoryIdentity(packageJson) {
  const publish = packageJson?.build?.publish;
  if (!Array.isArray(publish) || publish.length !== 1) {
    fail("package.json build.publish must be an array with exactly one entry");
  }
  const [entry] = publish;
  if (entry?.provider !== "github") {
    fail(`package.json build.publish[0].provider must be "github" (got ${JSON.stringify(entry?.provider)})`);
  }
  const { owner, repo } = entry;
  if (typeof owner !== "string" || !OWNER.test(owner)) {
    fail(`package.json build.publish[0].owner is not a GitHub owner name (got ${JSON.stringify(owner)})`);
  }
  if (typeof repo !== "string" || !REPO.test(repo)) {
    fail(`package.json build.publish[0].repo is not a GitHub repository name (got ${JSON.stringify(repo)})`);
  }
  return Object.freeze({ owner, repo, slug: `${owner}/${repo}` });
}

export function readRepositoryIdentity(root = ROOT) {
  return repositoryIdentity(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));
}
