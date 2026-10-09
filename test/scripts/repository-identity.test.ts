import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readRepositoryIdentity,
  repositoryIdentity,
} from "../../scripts/lib/repository-identity.mjs";

/**
 * `package.json` `build.publish` names this repository once; it is what
 * installed apps update from. These tests hold every other place that must
 * name the repository to that entry, so changing the owner or name fails here
 * until each place agrees — instead of a workflow skipping silently or the
 * website linking to a feed the app no longer uses.
 */

const root = process.cwd();
const identity = readRepositoryIdentity(root);

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function githubPublish(owner: unknown, repo: unknown) {
  return { build: { publish: [{ provider: "github", owner, repo }] } };
}

/** `job id -> body` for the top-level `jobs:` block of a workflow. */
function workflowJobs(source: string): Map<string, string> {
  const start = source.indexOf("\njobs:\n");
  if (start < 0) throw new Error("workflow has no top-level `jobs:` block");
  const jobs = new Map<string, string>();
  let id: string | null = null;
  for (const line of source.slice(start + "\njobs:\n".length).split("\n")) {
    const header = /^ {2}([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/u.exec(line);
    if (header) {
      id = header[1] as string;
      jobs.set(id, "");
      continue;
    }
    if (id !== null) jobs.set(id, `${jobs.get(id)}${line}\n`);
  }
  return jobs;
}

describe("repository identity source of truth", () => {
  it("reads owner/repo from the one github publish entry", () => {
    expect(repositoryIdentity(githubPublish("some-owner", "ave"))).toEqual({
      owner: "some-owner",
      repo: "ave",
      slug: "some-owner/ave",
    });
  });

  it.each([
    ["no build", {}],
    ["publish as an object", { build: { publish: { provider: "github", owner: "o", repo: "r" } } }],
    ["no publish entry", { build: { publish: [] } }],
    [
      "a second feed",
      {
        build: {
          publish: [
            { provider: "github", owner: "o", repo: "r" },
            { provider: "github", owner: "p", repo: "r" },
          ],
        },
      },
    ],
    ["a non-github provider", { build: { publish: [{ provider: "generic", url: "https://example.invalid" }] } }],
    ["a missing owner", githubPublish(undefined, "ave")],
    ["an owner with a slash", githubPublish("a/b", "ave")],
    ["an owner with a trailing hyphen", githubPublish("owner-", "ave")],
    ["an empty repo", githubPublish("owner", "")],
    ["a dot-dot repo", githubPublish("owner", "..")],
  ])("fails closed for %s", (_label, packageJson) => {
    expect(() => repositoryIdentity(packageJson)).toThrow("[repository-identity]");
  });

  it("keeps the package homepage on the same repository", () => {
    const pkg = JSON.parse(read("package.json")) as { homepage?: string };
    expect(pkg.homepage).toBe(`https://github.com/${identity.slug}`);
  });

  it("guards every web deploy job on this repository", () => {
    const jobs = workflowJobs(read(".github/workflows/web-deploy.yml"));
    expect([...jobs.keys()]).toEqual(["build", "deploy"]);
    for (const [id, body] of jobs) {
      expect(body, `web-deploy.yml job ${id}`).toContain(
        `    if: github.repository == '${identity.slug}'\n`,
      );
    }
  });

  it("names this repository in every workflow repository comparison", () => {
    const workflowDir = resolve(root, ".github/workflows");
    const comparisons: string[] = [];
    for (const entry of readdirSync(workflowDir).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
      const source = read(`.github/workflows/${entry}`);
      for (const match of source.matchAll(
        /github\.repository(_owner)?\s*[!=]=\s*(?:'([^']*)'|"([^"]*)")/gu,
      )) {
        const expected = match[1] ? identity.owner : identity.slug;
        expect(match[2] ?? match[3], `${entry}: ${match[0]}`).toBe(expected);
        comparisons.push(entry);
      }
    }
    expect(comparisons).toContain("web-deploy.yml");
  });

  it("links the website's downloads to this repository's releases", () => {
    const source = read("web/lib/downloads.ts");
    const repositories = [...source.matchAll(/https:\/\/github\.com\/([^/"'`\s]+\/[^/"'`\s]+)/gu)].map(
      (match) => match[1],
    );
    expect(repositories.length).toBeGreaterThan(0);
    expect(new Set(repositories)).toEqual(new Set([identity.slug]));
    expect(source).toContain(`"https://github.com/${identity.slug}/releases"`);
  });

  it("points the packaged agent contract's gh commands at this repository's owner", () => {
    // resources/AGENTS.md is seeded into ~/.ave. Editing it also needs the
    // hash of every tagged copy in resources/AGENTS.md.replaceable-sha256.
    const source = read("resources/AGENTS.md");
    const owners = [...source.matchAll(/gh -R ([^/\s`]+)\//gu)].map((match) => match[1]);
    expect(owners.length).toBeGreaterThan(0);
    expect(new Set(owners)).toEqual(new Set([identity.owner]));
  });
});
